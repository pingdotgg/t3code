import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HermesGatewayCredential,
  HermesGatewayRequestId,
  HermesGatewaySessionId,
  ProviderInstanceId,
  ThreadId,
  type HermesGatewayConnectionHello,
  type HermesGatewayT3ToPluginMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HermesDriver } from "../Drivers/HermesDriver.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  HermesGatewayBroker,
  type HermesGatewayTransport,
} from "../Services/HermesGatewayBroker.ts";
import { HermesGatewayBrokerLive, makeHermesGatewayBroker } from "./HermesGatewayBroker.ts";

const instanceId = ProviderInstanceId.make("hermes_remote");
const otherInstanceId = ProviderInstanceId.make("hermes_other");
class HermesTestInstance extends Context.Service<HermesTestInstance, ProviderInstance>()(
  "t3/provider/Layers/HermesGatewayBroker.test/HermesTestInstance",
) {}

const capabilities = {
  protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
  streaming: true,
  activity: true,
  approvals: true,
  userInput: true,
  attachments: false,
} as const;

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const service: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => values.set(name, value)).pipe(Effect.asVoid),
    create: (name, value) => Effect.sync(() => values.set(name, value)).pipe(Effect.asVoid),
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
    remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  };
  return service;
};

const makeBroker = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  makeHermesGatewayBroker.pipe(
    Effect.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
          [otherInstanceId]: { driver: "hermes", displayName: "Other", config: {} },
        },
      }),
    ),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provide(NodeServices.layer),
  );

const hello = (
  authentication: HermesGatewayConnectionHello["authentication"],
  protocolVersion: number = HERMES_GATEWAY_PROTOCOL_VERSION,
): HermesGatewayConnectionHello => ({
  type: "connection.hello",
  requestId: HermesGatewayRequestId.make(`hello-${protocolVersion}`),
  protocolVersion,
  pluginVersion: "0.1.0",
  hermesVersion: "1.0.0",
  capabilities: { ...capabilities, protocolVersion },
  authentication,
});

it.effect("authenticates before applying incompatible connection state", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const broker = yield* makeBroker(secrets);
    yield* broker.createEnrollment({
      instanceId: ProviderInstanceId.make("hermes"),
      nickname: "Default Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const enrollment = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });

    const firstCloses: Array<number> = [];
    const firstTransport: HermesGatewayTransport = {
      send: () => Effect.void,
      close: (code) => Effect.sync(() => firstCloses.push(code)).pipe(Effect.asVoid),
    };
    const first = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      firstTransport,
    );
    assert.isTrue(first.accepted.credential !== undefined);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");

    const secondCloses: Array<number> = [];
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const secondTransport: HermesGatewayTransport = {
      send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
      close: (code) => Effect.sync(() => secondCloses.push(code)).pipe(Effect.asVoid),
    };
    const second = yield* broker.registerConnection(
      hello({
        type: "instance-credential",
        instanceId,
        credential: first.accepted.credential!,
      }),
      secondTransport,
    );
    assert.deepEqual(firstCloses, [4001]);

    const threadId = ThreadId.make("pending-thread");
    const pendingRequestId = HermesGatewayRequestId.make("pending-session");
    const pendingRequest = yield* broker
      .request(instanceId, {
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: pendingRequestId,
        threadId,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    assert.equal(sent.at(-1)?.type, "session.ensure");

    const malicious = yield* Effect.flip(
      broker.registerConnection(
        hello(
          {
            type: "instance-credential",
            instanceId,
            credential: HermesGatewayCredential.make("not-the-real-credential"),
          },
          2,
        ),
        secondTransport,
      ),
    );
    assert.equal(malicious.code, "invalid-authentication");
    assert.deepEqual(secondCloses, []);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");
    assert.isUndefined(pendingRequest.pollUnsafe());

    yield* broker.receive(second, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: pendingRequestId,
      threadId,
      sessionId: HermesGatewaySessionId.make("pending-session-id"),
      resumed: false,
    });
    assert.equal((yield* Fiber.join(pendingRequest)).type, "session.ready");

    const incompatible = yield* Effect.flip(
      broker.registerConnection(
        hello(
          {
            type: "instance-credential",
            instanceId,
            credential: first.accepted.credential!,
          },
          2,
        ),
        secondTransport,
      ),
    );
    assert.equal(incompatible.code, "version-incompatible");
    assert.deepEqual(secondCloses, [4004]);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "upgrade-required");

    const otherEnrollment = yield* broker.createEnrollment({
      instanceId: otherInstanceId,
      nickname: "Other Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const incompatibleEnrollment = yield* Effect.flip(
      broker.registerConnection(
        hello({ type: "enrollment-token", token: otherEnrollment.oneTimeToken }, 2),
        secondTransport,
      ),
    );
    assert.equal(incompatibleEnrollment.code, "version-incompatible");
    const enrolledAfterUpgrade = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: otherEnrollment.oneTimeToken }),
      secondTransport,
    );
    assert.equal(enrolledAfterUpgrade.instanceId, otherInstanceId);

    const revoked = yield* broker.revokeInstance(instanceId);
    assert.equal(revoked.status, "revoked");
  }),
);

it.effect("invalidates the previous credential when replacement enrollment begins", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const closes: Array<number> = [];
    const transport: HermesGatewayTransport = {
      send: () => Effect.void,
      close: (code) => Effect.sync(() => closes.push(code)).pipe(Effect.asVoid),
    };
    const first = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );
    const replacement = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    assert.deepEqual(closes, [4001]);

    const staleCredential = yield* Effect.flip(
      broker.registerConnection(
        hello({
          type: "instance-credential",
          instanceId,
          credential: first.accepted.credential!,
        }),
        transport,
      ),
    );
    assert.equal(staleCredential.code, "invalid-authentication");
    const replacementConnection = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: replacement.oneTimeToken }),
      transport,
    );
    assert.equal(replacementConnection.instanceId, instanceId);
  }),
);

it.effect("accepts only the newest unconsumed enrollment token for an instance", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const older = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const newest = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const transport: HermesGatewayTransport = {
      send: () => Effect.void,
      close: () => Effect.void,
    };

    const olderTokenError = yield* Effect.flip(
      broker.registerConnection(
        hello({ type: "enrollment-token", token: older.oneTimeToken }),
        transport,
      ),
    );
    assert.equal(olderTokenError.code, "enrollment-expired");
    const newestConnection = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: newest.oneTimeToken }),
      transport,
    );
    assert.equal(newestConnection.instanceId, instanceId);
  }),
);

it.effect("atomically reserves normalized nicknames across concurrent enrollments", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    const firstPersistStarted = yield* Deferred.make<void>();
    const releaseFirstPersist = yield* Deferred.make<void>();
    let metadataPersistCount = 0;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      set: (name, value) =>
        name.startsWith("hermes-gateway-metadata-")
          ? Effect.gen(function* () {
              metadataPersistCount += 1;
              if (metadataPersistCount === 1) {
                yield* Deferred.succeed(firstPersistStarted, undefined);
                yield* Deferred.await(releaseFirstPersist);
              }
              yield* storedSecrets.set(name, value);
            })
          : storedSecrets.set(name, value),
    };
    const broker = yield* makeBroker(secrets);
    const firstEnrollment = yield* broker
      .createEnrollment({
        instanceId,
        nickname: "Shared Hermes",
        connectorUrl: "https://t3.example.test",
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(firstPersistStarted);
    const secondEnrollment = yield* broker
      .createEnrollment({
        instanceId: otherInstanceId,
        nickname: "  Shared Hermes  ",
        connectorUrl: "https://t3.example.test",
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    for (let index = 0; index < 10; index += 1) {
      yield* Effect.yieldNow;
    }
    assert.equal(metadataPersistCount, 1);

    yield* Deferred.succeed(releaseFirstPersist, undefined);
    yield* Fiber.join(firstEnrollment);
    const conflict = yield* Effect.flip(Fiber.join(secondEnrollment));
    assert.equal(conflict.code, "nickname-conflict");
    assert.equal(metadataPersistCount, 1);
  }),
);

it.effect("keeps a revoked instance nickname reserved", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Reserved Hermes",
      connectorUrl: "https://t3.example.test",
    });
    assert.equal((yield* broker.revokeInstance(instanceId)).status, "revoked");

    const conflict = yield* Effect.flip(
      broker.createEnrollment({
        instanceId: otherInstanceId,
        nickname: "  Reserved Hermes  ",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(conflict.code, "nickname-conflict");
  }),
);

it.effect("finalizes revocation when credential deletion fails", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    let failRemovals = false;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      remove: (name) =>
        failRemovals
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause: new Error("forced credential deletion failure"),
              }),
            )
          : storedSecrets.remove(name),
    };
    const broker = yield* makeBroker(secrets);
    const enrollment = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const closes: Array<number> = [];
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      {
        send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        close: (code) => Effect.sync(() => closes.push(code)).pipe(Effect.asVoid),
      },
    );
    const credential = registration.accepted.credential;
    if (!credential) {
      return yield* Effect.die(new Error("enrollment did not issue a credential"));
    }

    const threadId = ThreadId.make("revoke-pending-thread");
    const pendingRequestId = HermesGatewayRequestId.make("revoke-pending-request");
    const pendingRequest = yield* broker
      .request(instanceId, {
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: pendingRequestId,
        threadId,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    assert.equal(sent.at(-1)?.type, "session.ensure");
    const statusEvent = yield* Stream.runHead(broker.streamStatuses).pipe(
      Effect.forkChild({ startImmediately: true }),
    );

    failRemovals = true;
    const revokeError = yield* Effect.flip(broker.revokeInstance(instanceId));
    assert.equal(revokeError.code, "persistence-failed");
    assert.deepEqual(closes, [4003]);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "revoked");
    assert.equal(Option.getOrUndefined(yield* Fiber.join(statusEvent))?.status, "revoked");
    const pendingError = yield* Effect.flip(Fiber.join(pendingRequest));
    assert.include(pendingError.detail, "revoked");

    const staleReconnect = yield* Effect.flip(
      broker.registerConnection(hello({ type: "instance-credential", instanceId, credential }), {
        send: () => Effect.void,
        close: () => Effect.void,
      }),
    );
    assert.equal(staleReconnect.code, "instance-revoked");

    const restartedBroker = yield* makeBroker(secrets);
    const staleReconnectAfterRestart = yield* Effect.flip(
      restartedBroker.registerConnection(
        hello({ type: "instance-credential", instanceId, credential }),
        {
          send: () => Effect.void,
          close: () => Effect.void,
        },
      ),
    );
    assert.equal(staleReconnectAfterRestart.code, "instance-revoked");
  }),
);

it.effect("shares one live broker between the gateway route and Hermes provider instance", () => {
  const secrets = makeSecretStore();
  const providerLayer = Layer.effect(
    HermesTestInstance,
    HermesDriver.create({
      instanceId,
      displayName: "Remote Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }),
  ).pipe(
    Layer.provideMerge(HermesGatewayBrokerLive),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
        },
      }),
    ),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    const provider = yield* HermesTestInstance;
    const enrollment = yield* broker.createEnrollment({
      instanceId,
      nickname: "Remote Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      {
        send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
        close: () => Effect.void,
      },
    );
    assert.equal((yield* provider.snapshot.getSnapshot).status, "ready");

    const threadId = ThreadId.make("shared-broker-thread");
    const startSession = yield* provider.adapter
      .startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const ensure = sent.at(-1);
    if (!ensure || ensure.type !== "session.ensure") {
      return yield* Effect.die(new Error("session.ensure did not reach the gateway transport"));
    }
    const sessionId = HermesGatewaySessionId.make("shared-broker-session");
    yield* broker.receive(registration, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: ensure.requestId,
      threadId,
      sessionId,
      resumed: false,
    });
    yield* Fiber.join(startSession);

    const sendTurn = yield* provider.adapter
      .sendTurn({ threadId, input: "hello through the shared broker" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const turnStart = sent.at(-1);
    if (!turnStart || turnStart.type !== "turn.start") {
      return yield* Effect.die(new Error("turn.start did not reach the gateway transport"));
    }
    yield* broker.receive(registration, {
      type: "turn.started",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: turnStart.requestId,
      threadId,
      sessionId,
      turnId: turnStart.turnId,
    });
    assert.equal((yield* Fiber.join(sendTurn)).turnId, turnStart.turnId);
  }).pipe(Effect.provide(providerLayer), Effect.scoped);
});

it.effect("checks nickname uniqueness from persisted metadata after restart", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const firstBroker = yield* makeBroker(secrets);
    yield* firstBroker.createEnrollment({
      instanceId,
      nickname: "Persistent Nickname",
      connectorUrl: "https://t3.example.test",
    });

    const restartedBroker = yield* makeBroker(secrets);
    const error = yield* Effect.flip(
      restartedBroker.createEnrollment({
        instanceId: otherInstanceId,
        nickname: "Persistent Nickname",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(error.code, "nickname-conflict");
  }),
);
