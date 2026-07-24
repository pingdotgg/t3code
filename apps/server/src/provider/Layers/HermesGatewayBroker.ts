import * as NodeCrypto from "node:crypto";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HERMES_DRIVER_KIND,
  defaultInstanceIdForDriver,
  HermesGatewayCredential,
  HermesGatewayEnrollmentToken,
  HermesGatewayCapabilities,
  HermesGatewayManagementError,
  type HermesGatewayConnectionHello,
  type HermesGatewayCreateEnrollmentInput,
  type HermesGatewayEnrollmentResult,
  type HermesGatewayInstanceStatus,
  type HermesGatewayPluginToT3Message,
  type HermesGatewayRevokeInstanceResult,
  type HermesGatewayT3ToPluginMessage,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import {
  HermesGatewayBroker,
  type HermesGatewayConnectionRegistration,
  type HermesGatewayEnvelope,
  type HermesGatewayTransport,
  type HermesGatewayBrokerShape,
} from "../Services/HermesGatewayBroker.ts";

const ENROLLMENT_TTL = Duration.minutes(10);
const REQUEST_TIMEOUT = Duration.seconds(30);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const isStrictCapabilities = Schema.is(HermesGatewayCapabilities);

interface PendingEnrollment {
  readonly input: HermesGatewayCreateEnrollmentInput;
  readonly expiresAtMillis: number;
}

interface InstanceMetadata {
  readonly nickname: string;
  readonly connectorUrl: string;
  readonly revoked: boolean;
  readonly lastSeen?: {
    readonly pluginVersion: string;
    readonly hermesVersion: string;
    readonly capabilities: NonNullable<HermesGatewayInstanceStatus["capabilities"]>;
    readonly connectedAt: string;
    readonly activeSessionCount: number;
  };
}

interface ActiveConnection {
  readonly generation: number;
  readonly transport: HermesGatewayTransport;
  readonly pluginVersion: string;
  readonly hermesVersion: string;
  readonly capabilities: NonNullable<HermesGatewayInstanceStatus["capabilities"]>;
  readonly connectedAt: string;
  readonly activeSessionCount: number;
}

interface InstanceState {
  readonly metadata: InstanceMetadata;
  readonly connection?: ActiveConnection;
  readonly lastSeen?: Omit<ActiveConnection, "transport" | "generation" | "activeSessionCount"> & {
    readonly activeSessionCount: number;
  };
  readonly upgradeRequired?: {
    readonly pluginVersion: string;
    readonly hermesVersion: string;
    readonly protocolVersion: number;
  };
}

type PluginMessage = Exclude<HermesGatewayPluginToT3Message, HermesGatewayConnectionHello>;

const credentialSecretName = (instanceId: ProviderInstanceId) =>
  `hermes-gateway-credential-${Buffer.from(instanceId, "utf8").toString("base64url")}`;

const metadataSecretName = (instanceId: ProviderInstanceId) =>
  `hermes-gateway-metadata-${Buffer.from(instanceId, "utf8").toString("base64url")}`;

const managementError = (
  operation: HermesGatewayManagementError["operation"],
  code: HermesGatewayManagementError["code"],
  message: string,
  instanceId?: ProviderInstanceId,
) =>
  new HermesGatewayManagementError({
    operation,
    code,
    message,
    ...(instanceId ? { instanceId } : {}),
  });

const rejection = (
  requestId: HermesGatewayConnectionHello["requestId"],
  code: Extract<HermesGatewayT3ToPluginMessage, { readonly type: "connection.rejected" }>["code"],
  message: string,
): Extract<HermesGatewayT3ToPluginMessage, { readonly type: "connection.rejected" }> => ({
  type: "connection.rejected",
  requestId,
  code,
  message,
  expectedProtocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
});

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const credentialsEqual = (left: Uint8Array, right: string) => {
  const rightBytes = textEncoder.encode(right);
  return left.byteLength === rightBytes.byteLength && NodeCrypto.timingSafeEqual(left, rightBytes);
};

const statusFromState = (
  instanceId: ProviderInstanceId,
  state: InstanceState,
): HermesGatewayInstanceStatus => ({
  ...(() => {
    const observed = state.connection ?? state.lastSeen ?? state.metadata.lastSeen;
    return {
      lastConnectedAt: observed?.connectedAt ?? null,
      pluginVersion: observed?.pluginVersion ?? state.upgradeRequired?.pluginVersion ?? null,
      hermesVersion: observed?.hermesVersion ?? state.upgradeRequired?.hermesVersion ?? null,
      activeSessionCount: state.connection?.activeSessionCount ?? 0,
      protocolVersion:
        observed?.capabilities.protocolVersion ?? state.upgradeRequired?.protocolVersion ?? null,
      capabilities: observed?.capabilities ?? null,
    };
  })(),
  instanceId,
  nickname: state.metadata.nickname,
  status: state.metadata.revoked
    ? "revoked"
    : state.upgradeRequired
      ? "upgrade-required"
      : state.connection
        ? "connected"
        : "offline",
  connectorUrl: state.metadata.connectorUrl,
});

export const makeHermesGatewayBroker = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const states = yield* Ref.make(new Map<ProviderInstanceId, InstanceState>());
  const enrollments = yield* Ref.make(new Map<string, PendingEnrollment>());
  const pendingRequests = yield* Ref.make(
    new Map<
      string,
      {
        readonly instanceId: ProviderInstanceId;
        readonly deferred: Deferred.Deferred<PluginMessage, ProviderAdapterRequestError>;
      }
    >(),
  );
  const events = yield* PubSub.unbounded<HermesGatewayEnvelope>();
  const statusEvents = yield* PubSub.unbounded<HermesGatewayInstanceStatus>();
  const generation = yield* Ref.make(0);
  const enrollmentSemaphore = yield* Semaphore.make(1);

  const publishStatus = (instanceId: ProviderInstanceId, state: InstanceState) =>
    PubSub.publish(statusEvents, statusFromState(instanceId, state)).pipe(Effect.asVoid);

  const failPendingRequests = (instanceId: ProviderInstanceId, detail: string) =>
    Effect.gen(function* () {
      const affected = yield* Ref.modify(pendingRequests, (current) => {
        const next = new Map(current);
        const found = Array.from(current.entries()).filter(
          ([, pending]) => pending.instanceId === instanceId,
        );
        for (const [requestId] of found) next.delete(requestId);
        return [found.map(([, pending]) => pending.deferred), next] as const;
      });
      yield* Effect.forEach(
        affected,
        (deferred) =>
          Deferred.fail(
            deferred,
            new ProviderAdapterRequestError({
              provider: HERMES_DRIVER_KIND,
              method: "connection",
              detail,
            }),
          ),
        { discard: true },
      );
    });

  const persistMetadata = (instanceId: ProviderInstanceId, metadata: InstanceMetadata) =>
    secretStore
      .set(metadataSecretName(instanceId), textEncoder.encode(JSON.stringify(metadata)))
      .pipe(
        Effect.mapError(() =>
          managementError(
            "create-enrollment",
            "persistence-failed",
            "Failed to persist Hermes gateway metadata.",
            instanceId,
          ),
        ),
      );

  const readMetadata = (instanceId: ProviderInstanceId) =>
    secretStore.get(metadataSecretName(instanceId)).pipe(
      Effect.map((stored) => {
        if (Option.isNone(stored)) return undefined;
        try {
          const parsed: unknown = JSON.parse(textDecoder.decode(stored.value));
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "nickname" in parsed &&
            typeof parsed.nickname === "string" &&
            "connectorUrl" in parsed &&
            typeof parsed.connectorUrl === "string" &&
            "revoked" in parsed &&
            typeof parsed.revoked === "boolean"
          ) {
            return {
              nickname: parsed.nickname,
              connectorUrl: parsed.connectorUrl,
              revoked: parsed.revoked,
              ...("lastSeen" in parsed &&
              typeof parsed.lastSeen === "object" &&
              parsed.lastSeen !== null &&
              "pluginVersion" in parsed.lastSeen &&
              typeof parsed.lastSeen.pluginVersion === "string" &&
              "hermesVersion" in parsed.lastSeen &&
              typeof parsed.lastSeen.hermesVersion === "string" &&
              "connectedAt" in parsed.lastSeen &&
              typeof parsed.lastSeen.connectedAt === "string" &&
              "activeSessionCount" in parsed.lastSeen &&
              typeof parsed.lastSeen.activeSessionCount === "number" &&
              "capabilities" in parsed.lastSeen &&
              isStrictCapabilities(parsed.lastSeen.capabilities)
                ? {
                    lastSeen: {
                      pluginVersion: parsed.lastSeen.pluginVersion,
                      hermesVersion: parsed.lastSeen.hermesVersion,
                      connectedAt: parsed.lastSeen.connectedAt,
                      activeSessionCount: parsed.lastSeen.activeSessionCount,
                      capabilities: parsed.lastSeen.capabilities,
                    },
                  }
                : {}),
            } satisfies InstanceMetadata;
          }
        } catch {
          return undefined;
        }
        return undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  const getState = (instanceId: ProviderInstanceId) =>
    Ref.get(states).pipe(
      Effect.map((current) => current.get(instanceId)),
      Effect.flatMap((state) => {
        if (state) return Effect.succeed(state);
        return readMetadata(instanceId).pipe(
          Effect.flatMap((metadata) => {
            if (!metadata) {
              return Effect.fail(
                managementError(
                  "get-status",
                  "instance-not-found",
                  `Hermes gateway instance '${instanceId}' has not been enrolled.`,
                  instanceId,
                ),
              );
            }
            const loaded: InstanceState = { metadata };
            return Ref.update(states, (current) => new Map(current).set(instanceId, loaded)).pipe(
              Effect.as(loaded),
            );
          }),
        );
      }),
    );

  const createEnrollment = (input: HermesGatewayCreateEnrollmentInput) =>
    enrollmentSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const normalizedNickname = input.nickname.trim();
        const normalizedInput = {
          ...input,
          nickname: normalizedNickname,
        } satisfies HermesGatewayCreateEnrollmentInput;
        const currentSettings = yield* settings.getSettings.pipe(
          Effect.mapError(() =>
            managementError(
              "create-enrollment",
              "internal-error",
              "Failed to read server settings.",
              input.instanceId,
            ),
          ),
        );
        const configured = currentSettings.providerInstances[input.instanceId];
        const isDefaultHermesInstance =
          input.instanceId === defaultInstanceIdForDriver(HERMES_DRIVER_KIND);
        if ((!configured || configured.driver !== HERMES_DRIVER_KIND) && !isDefaultHermesInstance) {
          return yield* managementError(
            "create-enrollment",
            "instance-not-found",
            `Provider instance '${input.instanceId}' is not configured with the Hermes driver.`,
            input.instanceId,
          );
        }

        const configuredHermesIds = [
          defaultInstanceIdForDriver(HERMES_DRIVER_KIND),
          ...Object.entries(currentSettings.providerInstances)
            .filter(([, config]) => config.driver === HERMES_DRIVER_KIND)
            .map(([instanceId]) => instanceId as ProviderInstanceId),
        ];
        const existingStates = yield* Ref.get(states);
        for (const instanceId of new Set(configuredHermesIds)) {
          const persistedMetadata = existingStates.has(instanceId)
            ? undefined
            : yield* readMetadata(instanceId);
          const state =
            existingStates.get(instanceId) ??
            (persistedMetadata ? { metadata: persistedMetadata } : undefined);
          if (!state) continue;
          if (instanceId !== input.instanceId && state.metadata.nickname === normalizedNickname) {
            return yield* managementError(
              "create-enrollment",
              "nickname-conflict",
              `A Hermes gateway named '${normalizedNickname}' already exists.`,
              input.instanceId,
            );
          }
        }

        const token = HermesGatewayEnrollmentToken.make(
          Encoding.encodeBase64Url(
            yield* crypto
              .randomBytes(32)
              .pipe(
                Effect.mapError(() =>
                  managementError(
                    "create-enrollment",
                    "internal-error",
                    "Failed to generate an enrollment token.",
                    input.instanceId,
                  ),
                ),
              ),
          ),
        );
        const expiresAtMillis =
          (yield* Clock.currentTimeMillis) + Duration.toMillis(ENROLLMENT_TTL);
        const previousState = existingStates.get(input.instanceId);
        const metadata = {
          nickname: normalizedNickname,
          connectorUrl: input.connectorUrl,
          revoked: false,
          ...(previousState?.metadata.lastSeen
            ? { lastSeen: previousState.metadata.lastSeen }
            : {}),
        } satisfies InstanceMetadata;
        yield* secretStore
          .remove(credentialSecretName(input.instanceId))
          .pipe(
            Effect.mapError(() =>
              managementError(
                "create-enrollment",
                "persistence-failed",
                "Failed to invalidate the previous Hermes gateway credential.",
                input.instanceId,
              ),
            ),
          );
        if (previousState?.connection) {
          yield* failPendingRequests(
            input.instanceId,
            "A new enrollment replaced the active Hermes gateway credential.",
          );
          yield* previousState.connection.transport.close(
            4001,
            "A new enrollment was created for this instance",
          );
        }
        yield* persistMetadata(input.instanceId, metadata);
        const enrolledState: InstanceState = {
          metadata,
          ...(previousState?.lastSeen ? { lastSeen: previousState.lastSeen } : {}),
        };
        yield* Ref.update(states, (current) =>
          new Map(current).set(input.instanceId, enrolledState),
        );
        yield* publishStatus(input.instanceId, enrolledState);
        yield* Ref.update(enrollments, (current) => {
          const next = new Map(current);
          for (const [pendingToken, pending] of current) {
            if (pending.input.instanceId === input.instanceId) {
              next.delete(pendingToken);
            }
          }
          return next.set(token, { input: normalizedInput, expiresAtMillis });
        });

        return {
          instanceId: input.instanceId,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMillis)),
          connectorUrl: input.connectorUrl,
          command: `hermes t3 connect --url ${shellQuote(input.connectorUrl)} --token ${shellQuote(token)}`,
          oneTimeToken: token,
        } satisfies HermesGatewayEnrollmentResult;
      }),
    );

  const getInstanceStatus = (instanceId: ProviderInstanceId) =>
    getState(instanceId).pipe(Effect.map((state) => statusFromState(instanceId, state)));

  const listInstances = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(() =>
        managementError("list-instances", "internal-error", "Failed to read server settings."),
      ),
    );
    const ids = Array.from(
      new Set([
        defaultInstanceIdForDriver(HERMES_DRIVER_KIND),
        ...Object.entries(currentSettings.providerInstances)
          .filter(([, config]) => config.driver === HERMES_DRIVER_KIND)
          .map(([id]) => id as ProviderInstanceId),
      ]),
    );
    return yield* Effect.forEach(
      ids,
      (instanceId) =>
        getInstanceStatus(instanceId).pipe(
          Effect.catchTag("HermesGatewayManagementError", () => Effect.succeed(undefined)),
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((values) => values.filter((value) => value !== undefined)));
  });

  const revokeInstance = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const state = yield* getState(instanceId);
      const metadata: InstanceMetadata = { ...state.metadata, revoked: true };
      yield* persistMetadata(instanceId, metadata).pipe(
        Effect.mapError((error) =>
          managementError("revoke-instance", error.code, error.message, instanceId),
        ),
      );
      const next: InstanceState = {
        metadata,
        ...(state.lastSeen ? { lastSeen: state.lastSeen } : {}),
      };
      yield* Ref.update(states, (current) => new Map(current).set(instanceId, next));
      if (state.connection) {
        yield* failPendingRequests(instanceId, "The Hermes gateway credential was revoked.");
        yield* state.connection.transport.close(4003, "Hermes gateway credential revoked");
      }
      yield* publishStatus(instanceId, next);
      yield* secretStore
        .remove(credentialSecretName(instanceId))
        .pipe(
          Effect.mapError(() =>
            managementError(
              "revoke-instance",
              "persistence-failed",
              "Failed to remove the Hermes gateway credential.",
              instanceId,
            ),
          ),
        );
      return statusFromState(instanceId, next) satisfies HermesGatewayRevokeInstanceResult;
    });

  const registerConnectionEffect = (
    hello: HermesGatewayConnectionHello,
    transport: HermesGatewayTransport,
  ) =>
    Effect.gen(function* () {
      const strictCapabilities = isStrictCapabilities(hello.capabilities)
        ? hello.capabilities
        : undefined;

      let instanceId: ProviderInstanceId;
      let credential: HermesGatewayCredential | undefined;
      let authenticatedEnrollment: PendingEnrollment | undefined;
      let state: InstanceState;
      if (hello.authentication.type === "enrollment-token") {
        const authentication = hello.authentication;
        const enrollment = (yield* Ref.get(enrollments)).get(authentication.token);
        if (!enrollment || enrollment.expiresAtMillis < (yield* Clock.currentTimeMillis)) {
          return yield* Effect.fail(
            rejection(
              hello.requestId,
              "enrollment-expired",
              "The enrollment token is invalid, expired, or already used.",
            ),
          );
        }
        instanceId = enrollment.input.instanceId;
        authenticatedEnrollment = enrollment;
        state = yield* getState(instanceId).pipe(
          Effect.mapError(() =>
            rejection(
              hello.requestId,
              "invalid-authentication",
              "Unknown Hermes gateway instance.",
            ),
          ),
        );
      } else {
        const authentication = hello.authentication;
        instanceId = authentication.instanceId;
        state = yield* getState(instanceId).pipe(
          Effect.mapError(() =>
            rejection(
              hello.requestId,
              "invalid-authentication",
              "Unknown Hermes gateway instance.",
            ),
          ),
        );
        if (state.metadata.revoked) {
          return yield* Effect.fail(
            rejection(
              hello.requestId,
              "instance-revoked",
              "This Hermes gateway instance has been revoked.",
            ),
          );
        }
        const stored = yield* secretStore
          .get(credentialSecretName(instanceId))
          .pipe(
            Effect.mapError(() =>
              rejection(
                hello.requestId,
                "internal-error",
                "Failed to read the gateway credential.",
              ),
            ),
          );
        if (Option.isNone(stored) || !credentialsEqual(stored.value, authentication.credential)) {
          return yield* Effect.fail(
            rejection(
              hello.requestId,
              "invalid-authentication",
              "The Hermes gateway credential is invalid.",
            ),
          );
        }
      }

      if (state.metadata.revoked) {
        return yield* Effect.fail(
          rejection(
            hello.requestId,
            "instance-revoked",
            "This Hermes gateway instance has been revoked.",
          ),
        );
      }

      if (
        hello.protocolVersion !== HERMES_GATEWAY_PROTOCOL_VERSION ||
        strictCapabilities === undefined
      ) {
        if (state.connection) {
          yield* failPendingRequests(
            instanceId,
            "The Hermes gateway plugin requires a protocol upgrade.",
          );
          yield* state.connection.transport.close(
            4004,
            "Hermes gateway protocol version is incompatible",
          );
        }
        const upgradeState: InstanceState = {
          metadata: state.metadata,
          ...(state.lastSeen ? { lastSeen: state.lastSeen } : {}),
          upgradeRequired: {
            pluginVersion: hello.pluginVersion,
            hermesVersion: hello.hermesVersion,
            protocolVersion: hello.protocolVersion,
          },
        };
        yield* Ref.update(states, (current) => new Map(current).set(instanceId, upgradeState));
        yield* publishStatus(instanceId, upgradeState);
        return yield* Effect.fail(
          rejection(
            hello.requestId,
            "version-incompatible",
            `Expected protocol version ${HERMES_GATEWAY_PROTOCOL_VERSION}.`,
          ),
        );
      }

      if (hello.authentication.type === "enrollment-token" && authenticatedEnrollment) {
        const authentication = hello.authentication;
        const enrollment = yield* Ref.modify(enrollments, (current) => {
          const found = current.get(authentication.token);
          const next = new Map(current);
          if (found === authenticatedEnrollment) next.delete(authentication.token);
          return [found, next] as const;
        });
        if (
          enrollment !== authenticatedEnrollment ||
          enrollment.expiresAtMillis < (yield* Clock.currentTimeMillis)
        ) {
          return yield* Effect.fail(
            rejection(
              hello.requestId,
              "enrollment-expired",
              "The enrollment token is invalid, expired, or already used.",
            ),
          );
        }
        instanceId = enrollment.input.instanceId;
        credential = HermesGatewayCredential.make(
          Encoding.encodeBase64Url(
            yield* crypto
              .randomBytes(32)
              .pipe(
                Effect.mapError(() =>
                  rejection(
                    hello.requestId,
                    "internal-error",
                    "Failed to generate the Hermes gateway credential.",
                  ),
                ),
              ),
          ),
        );
        yield* secretStore
          .set(credentialSecretName(instanceId), textEncoder.encode(credential))
          .pipe(
            Effect.mapError(() =>
              rejection(
                hello.requestId,
                "internal-error",
                "Failed to persist the Hermes gateway credential.",
              ),
            ),
          );
      }

      const nextGeneration = yield* Ref.getAndUpdate(generation, (value) => value + 1);
      const connectedAt = DateTime.formatIso(yield* DateTime.now);
      const connection = {
        generation: nextGeneration,
        transport,
        pluginVersion: hello.pluginVersion,
        hermesVersion: hello.hermesVersion,
        capabilities: strictCapabilities,
        connectedAt,
        activeSessionCount: 0,
      } satisfies ActiveConnection;
      const lastSeen = {
        pluginVersion: connection.pluginVersion,
        hermesVersion: connection.hermesVersion,
        capabilities: connection.capabilities,
        connectedAt: connection.connectedAt,
        activeSessionCount: connection.activeSessionCount,
      };
      const connectedMetadata: InstanceMetadata = {
        ...state.metadata,
        lastSeen,
      };
      yield* persistMetadata(instanceId, connectedMetadata).pipe(
        Effect.mapError(() =>
          rejection(
            hello.requestId,
            "internal-error",
            "Failed to persist Hermes gateway connection metadata.",
          ),
        ),
      );
      if (state.connection) {
        yield* failPendingRequests(
          instanceId,
          "The Hermes gateway connection was replaced by a newer connection.",
        );
        yield* state.connection.transport.close(4001, "Replaced by a newer connection");
      }
      yield* Ref.update(states, (current) =>
        new Map(current).set(instanceId, {
          metadata: connectedMetadata,
          connection,
          lastSeen,
        }),
      );
      yield* publishStatus(instanceId, {
        metadata: connectedMetadata,
        connection,
        lastSeen,
      });

      const accepted = {
        type: "connection.accepted",
        requestId: hello.requestId,
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        instanceId,
        nickname: state.metadata.nickname,
        ...(credential ? { credential } : {}),
      } as const;
      return {
        instanceId,
        generation: nextGeneration,
        accepted,
      } satisfies HermesGatewayConnectionRegistration;
    });

  const registerConnection = (
    hello: HermesGatewayConnectionHello,
    transport: HermesGatewayTransport,
  ) =>
    hello.authentication.type === "enrollment-token"
      ? enrollmentSemaphore.withPermits(1)(registerConnectionEffect(hello, transport))
      : registerConnectionEffect(hello, transport);

  const receive = (registration: HermesGatewayConnectionRegistration, message: PluginMessage) =>
    Effect.gen(function* () {
      const state = (yield* Ref.get(states)).get(registration.instanceId);
      if (state?.connection?.generation !== registration.generation) return;
      if (message.type === "connection.status") {
        yield* Ref.update(states, (current) => {
          const found = current.get(registration.instanceId);
          if (found?.connection?.generation !== registration.generation) return current;
          return new Map(current).set(registration.instanceId, {
            ...found,
            connection: {
              ...found.connection,
              activeSessionCount: message.activeSessionCount,
            },
          });
        });
        const updated = (yield* Ref.get(states)).get(registration.instanceId);
        if (updated) yield* publishStatus(registration.instanceId, updated);
      }
      if ("requestId" in message && message.requestId) {
        const correlatedRequestId = message.requestId;
        const pending = yield* Ref.modify(pendingRequests, (current) => {
          const found = current.get(correlatedRequestId);
          if (!found) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(correlatedRequestId);
          return [found, next] as const;
        });
        if (pending) {
          yield* Deferred.succeed(pending.deferred, message);
        }
      }
      yield* PubSub.publish(events, {
        instanceId: registration.instanceId,
        message,
      });
    });

  const disconnect = (registration: HermesGatewayConnectionRegistration) =>
    Effect.gen(function* () {
      let disconnected: InstanceState | undefined;
      yield* Ref.update(states, (current) => {
        const found = current.get(registration.instanceId);
        if (found?.connection?.generation !== registration.generation) return current;
        const next = new Map(current);
        const lastSeen = {
          pluginVersion: found.connection.pluginVersion,
          hermesVersion: found.connection.hermesVersion,
          capabilities: found.connection.capabilities,
          connectedAt: found.connection.connectedAt,
          activeSessionCount: found.connection.activeSessionCount,
        };
        disconnected = {
          metadata: { ...found.metadata, lastSeen },
          lastSeen,
        };
        next.set(registration.instanceId, disconnected);
        return next;
      });
      if (disconnected) {
        yield* persistMetadata(registration.instanceId, disconnected.metadata).pipe(Effect.ignore);
      }
      if (disconnected) yield* publishStatus(registration.instanceId, disconnected);
      if (disconnected) {
        yield* failPendingRequests(
          registration.instanceId,
          "The Hermes gateway connection disconnected.",
        );
      }
    });

  const send = (instanceId: ProviderInstanceId, message: HermesGatewayT3ToPluginMessage) =>
    Effect.gen(function* () {
      const state = (yield* Ref.get(states)).get(instanceId);
      if (!state?.connection) {
        return yield* new ProviderAdapterRequestError({
          provider: "hermes",
          method: message.type,
          detail: `Hermes gateway instance '${instanceId}' is offline.`,
        });
      }
      yield* state.connection.transport.send(message);
    });

  const request = (instanceId: ProviderInstanceId, message: HermesGatewayT3ToPluginMessage) =>
    Effect.gen(function* () {
      if (!("requestId" in message) || !message.requestId) {
        return yield* new ProviderAdapterRequestError({
          provider: "hermes",
          method: message.type,
          detail: "A correlated Hermes gateway request requires a request id.",
        });
      }
      const deferred = yield* Deferred.make<PluginMessage, ProviderAdapterRequestError>();
      yield* Ref.update(pendingRequests, (current) =>
        new Map(current).set(message.requestId as string, {
          instanceId,
          deferred,
        }),
      );
      yield* send(instanceId, message).pipe(
        Effect.tapError(() =>
          Ref.update(pendingRequests, (current) => {
            const next = new Map(current);
            next.delete(message.requestId as string);
            return next;
          }),
        ),
      );
      return yield* Deferred.await(deferred).pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError((error) =>
          error._tag === "TimeoutError"
            ? new ProviderAdapterRequestError({
                provider: "hermes",
                method: message.type,
                detail: "Hermes gateway request timed out.",
              })
            : error,
        ),
        Effect.ensuring(
          Ref.update(pendingRequests, (current) => {
            const next = new Map(current);
            next.delete(message.requestId as string);
            return next;
          }),
        ),
      );
    });

  const isConnected = (instanceId: ProviderInstanceId) =>
    Ref.get(states).pipe(
      Effect.map((current) => current.get(instanceId)?.connection !== undefined),
    );

  return {
    createEnrollment,
    getInstanceStatus,
    listInstances,
    revokeInstance,
    registerConnection,
    receive,
    disconnect,
    request,
    send,
    isConnected,
    stream: Stream.fromPubSub(events),
    streamStatuses: Stream.fromPubSub(statusEvents),
  } satisfies HermesGatewayBrokerShape;
});

export const HermesGatewayBrokerLive = Layer.effect(HermesGatewayBroker, makeHermesGatewayBroker);
