import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HERMES_GATEWAY_PROTOCOL_VERSION,
  HERMES_DRIVER_KIND,
  HermesGatewayCredential,
  HermesGatewayRequestId,
  HermesGatewaySessionId,
  ProviderDriverKind,
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
import * as ServerConfig from "../../config.ts";
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
const defaultHermesInstanceId = ProviderInstanceId.make("hermes");
const metadataSecretNameForTest = (id: ProviderInstanceId) =>
  `hermes-gateway-metadata-${Buffer.from(id, "utf8").toString("base64url")}`;
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
          [defaultHermesInstanceId]: {
            driver: "hermes",
            displayName: "Hermes",
            config: {},
          },
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
      instanceId: defaultHermesInstanceId,
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
        nickname: "  SHARED HERMES  ",
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

it.effect(
  "renames the display label while preserving instance identity and normalized uniqueness",
  () =>
    Effect.gen(function* () {
      const broker = yield* makeHermesGatewayBroker;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* broker.createEnrollment({
        instanceId,
        nickname: "Remote Hermes",
        connectorUrl: "https://t3.example.test",
      });
      yield* broker.createEnrollment({
        instanceId: otherInstanceId,
        nickname: "Other Hermes",
        connectorUrl: "https://t3.example.test",
      });

      const renamed = yield* broker.renameInstance({
        instanceId,
        nickname: "Research Hermes",
      });
      assert.equal(renamed.instanceId, instanceId);
      assert.equal(renamed.nickname, "Research Hermes");
      assert.equal(
        (yield* settings.getSettings).providerInstances[instanceId]?.displayName,
        "Research Hermes",
      );

      const conflict = yield* Effect.flip(
        broker.renameInstance({
          instanceId: otherInstanceId,
          nickname: "  RESEARCH HERMES  ",
        }),
      );
      assert.equal(conflict.operation, "rename-instance");
      assert.equal(conflict.code, "nickname-conflict");
      assert.equal((yield* broker.getInstanceStatus(otherInstanceId)).nickname, "Other Hermes");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            providerInstances: {
              [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
              [otherInstanceId]: { driver: "hermes", displayName: "Other", config: {} },
            },
          }),
          Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
          NodeServices.layer,
        ),
      ),
    ),
);

it.effect("preserves concurrent provider settings edits during rename and removal", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    let metadataGate:
      | {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        }
      | undefined;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      set: (name, value) => {
        const gate = metadataGate;
        if (!gate || !name.startsWith("hermes-gateway-metadata-")) {
          return storedSecrets.set(name, value);
        }
        metadataGate = undefined;
        return Effect.gen(function* () {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
          yield* storedSecrets.set(name, value);
        });
      },
    };
    const broker = yield* makeHermesGatewayBroker.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Concurrent Hermes",
      connectorUrl: "https://t3.example.test",
    });

    const renameStarted = yield* Deferred.make<void>();
    const releaseRename = yield* Deferred.make<void>();
    metadataGate = { started: renameStarted, release: releaseRename };
    const rename = yield* broker
      .renameInstance({ instanceId, nickname: "Concurrent Research" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(renameStarted);
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        codex_concurrent: { driver: "codex", displayName: "Concurrent Codex", config: {} },
      },
    }));
    yield* Deferred.succeed(releaseRename, undefined);
    yield* Fiber.join(rename);
    assert.equal(
      (yield* settings.getSettings).providerInstances[ProviderInstanceId.make("codex_concurrent")]
        ?.displayName,
      "Concurrent Codex",
    );

    yield* broker.revokeInstance(instanceId);
    const removeStarted = yield* Deferred.make<void>();
    const releaseRemove = yield* Deferred.make<void>();
    metadataGate = { started: removeStarted, release: releaseRemove };
    const remove = yield* broker
      .removeInstance(instanceId)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(removeStarted);
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        claude_concurrent: {
          driver: "claudeAgent",
          displayName: "Concurrent Claude",
          config: {},
        },
      },
    }));
    yield* Deferred.succeed(releaseRemove, undefined);
    yield* Fiber.join(remove);
    const finalSettings = yield* settings.getSettings;
    assert.equal(
      finalSettings.providerInstances[ProviderInstanceId.make("codex_concurrent")]?.displayName,
      "Concurrent Codex",
    );
    assert.equal(
      finalSettings.providerInstances[ProviderInstanceId.make("claude_concurrent")]?.displayName,
      "Concurrent Claude",
    );
    assert.isUndefined(finalSettings.providerInstances[instanceId]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
            [otherInstanceId]: { driver: "hermes", displayName: "Other", config: {} },
          },
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("tombstones removed instance ids while freeing their nickname", () =>
  Effect.gen(function* () {
    const broker = yield* makeHermesGatewayBroker;
    const settings = yield* ServerSettings.ServerSettingsService;
    const enrollment = yield* broker.createEnrollment({
      instanceId,
      nickname: "Disposable Hermes",
      connectorUrl: "https://t3.example.test",
    });
    const transport: HermesGatewayTransport = {
      send: () => Effect.void,
      close: () => Effect.void,
    };
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );
    const staleCredential = registration.accepted.credential;
    if (!staleCredential) {
      return yield* Effect.die(new Error("enrollment did not issue a credential"));
    }

    const liveError = yield* Effect.flip(broker.removeInstance(instanceId));
    assert.equal(liveError.operation, "remove-instance");
    assert.equal(liveError.code, "instance-not-revoked");

    yield* broker.revokeInstance(instanceId);
    assert.deepEqual(yield* broker.removeInstance(instanceId), { instanceId });
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    assert.isFalse(
      (yield* broker.listInstances).some((status) => status.instanceId === instanceId),
    );
    const missing = yield* Effect.flip(broker.getInstanceStatus(instanceId));
    assert.equal(missing.code, "instance-not-found");

    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        [instanceId]: { driver: "hermes", displayName: "Reused Hermes", config: {} },
      },
    }));
    const tombstoneError = yield* Effect.flip(
      broker.createEnrollment({
        instanceId,
        nickname: "Reused Hermes",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(tombstoneError.code, "instance-removed");
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    assert.isFalse(
      (yield* broker.listInstances).some((status) => status.instanceId === instanceId),
    );
    const staleConnection = yield* Effect.flip(
      broker.registerConnection(
        hello({
          type: "instance-credential",
          instanceId,
          credential: staleCredential,
        }),
        transport,
      ),
    );
    assert.equal(staleConnection.code, "invalid-authentication");

    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        [instanceId]: { driver: "hermes", displayName: "Reused Again", config: {} },
      },
    }));
    const restartedBroker = yield* makeHermesGatewayBroker;
    const restartedError = yield* Effect.flip(
      restartedBroker.createEnrollment({
        instanceId,
        nickname: "Reused Hermes",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(restartedError.code, "instance-removed");
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);

    const replacement = yield* broker.createEnrollment({
      instanceId: otherInstanceId,
      nickname: "disposable hermes",
      connectorUrl: "https://t3.example.test",
    });
    assert.equal(replacement.instanceId, otherInstanceId);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
            [otherInstanceId]: { driver: "hermes", displayName: "Other", config: {} },
          },
        }),
        Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("keeps the in-memory tombstone when credential cleanup fails", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    let failCredentialCleanup = false;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      remove: (name) =>
        failCredentialCleanup && name.startsWith("hermes-gateway-credential-")
          ? Effect.fail(
              new ServerSecretStore.SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause: new Error("forced credential cleanup failure"),
              }),
            )
          : storedSecrets.remove(name),
    };
    const broker = yield* makeHermesGatewayBroker.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Cleanup Failure Hermes",
      connectorUrl: "https://t3.example.test",
    });
    yield* broker.revokeInstance(instanceId);

    failCredentialCleanup = true;
    assert.deepEqual(yield* broker.removeInstance(instanceId), { instanceId });
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        [instanceId]: { driver: "hermes", displayName: "Forbidden Reuse", config: {} },
      },
    }));
    const error = yield* Effect.flip(
      broker.createEnrollment({
        instanceId,
        nickname: "Forbidden Reuse",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(error.code, "instance-removed");
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Cleanup Failure Hermes", config: {} },
          },
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("keeps the tombstone when settings post-commit materialization degrades", () => {
  const storedSecrets = makeSecretStore();
  const sensitiveInstanceId = ProviderInstanceId.make("codex_sensitive");
  let providerEnvironmentReadsBeforeFailure = Number.POSITIVE_INFINITY;
  const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
    ...storedSecrets,
    get: (name) => {
      if (!name.startsWith("provider-env-")) return storedSecrets.get(name);
      if (providerEnvironmentReadsBeforeFailure <= 0) {
        return Effect.fail(
          new ServerSecretStore.SecretStoreReadError({
            resource: `secret ${name}`,
            cause: new Error("forced post-commit materialization failure"),
          }),
        );
      }
      providerEnvironmentReadsBeforeFailure -= 1;
      return storedSecrets.get(name);
    },
  };
  const secretLayer = Layer.succeed(ServerSecretStore.ServerSecretStore, secrets);
  const configLayer = Layer.fresh(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-hermes-post-commit-settings-test-",
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const settingsLayer = ServerSettings.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provideMerge(configLayer),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      providerInstances: {
        [instanceId]: {
          driver: HERMES_DRIVER_KIND,
          displayName: "Post Commit Hermes",
          config: {},
        },
        [sensitiveInstanceId]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [
            {
              name: "OPENROUTER_API_KEY",
              value: "secret",
              sensitive: true,
            },
          ],
          config: {},
        },
      },
    });
    const broker = yield* makeHermesGatewayBroker;
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Post Commit Hermes",
      connectorUrl: "https://t3.example.test",
    });
    yield* broker.revokeInstance(instanceId);
    providerEnvironmentReadsBeforeFailure = 1;
    assert.deepEqual(yield* broker.removeInstance(instanceId), { instanceId });

    providerEnvironmentReadsBeforeFailure = Number.POSITIVE_INFINITY;
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        [instanceId]: {
          driver: HERMES_DRIVER_KIND,
          displayName: "Forbidden Reuse",
          config: {},
        },
      },
    }));
    const error = yield* Effect.flip(
      broker.createEnrollment({
        instanceId,
        nickname: "Forbidden Reuse",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(error.code, "instance-removed");
  }).pipe(
    Effect.provide(Layer.mergeAll(settingsLayer, secretLayer, configLayer, NodeServices.layer)),
  );
});

it.effect("migrates legacy default metadata into an explicit visible provider instance", () =>
  Effect.gen(function* () {
    const broker = yield* makeHermesGatewayBroker;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* broker.createEnrollment({
      instanceId: defaultHermesInstanceId,
      nickname: "Legacy Hermes",
      connectorUrl: "https://t3.example.test",
    });
    yield* settings.updateSettingsWith((current) => {
      const providerInstances = { ...current.providerInstances };
      delete providerInstances[defaultHermesInstanceId];
      return { providerInstances };
    });
    assert.isUndefined((yield* settings.getSettings).providerInstances[defaultHermesInstanceId]);

    yield* makeHermesGatewayBroker;
    assert.deepEqual((yield* settings.getSettings).providerInstances[defaultHermesInstanceId], {
      driver: HERMES_DRIVER_KIND,
      displayName: "Legacy Hermes",
      enabled: true,
      config: {},
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [defaultHermesInstanceId]: {
              driver: "hermes",
              displayName: "Hermes",
              enabled: true,
              config: {},
            },
          },
        }),
        Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("removes an explicitly configured Hermes instance that was never enrolled", () =>
  Effect.gen(function* () {
    const broker = yield* makeHermesGatewayBroker;
    const settings = yield* ServerSettings.ServerSettingsService;

    assert.deepEqual(yield* broker.removeInstance(instanceId), { instanceId });
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    assert.equal(
      (yield* Effect.flip(broker.getInstanceStatus(instanceId))).code,
      "instance-not-found",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Never Enrolled", config: {} },
          },
        }),
        Layer.succeed(ServerSecretStore.ServerSecretStore, makeSecretStore()),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("fails closed when tombstone metadata cannot be read", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    let failMetadataReads = false;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      get: (name) =>
        failMetadataReads && name === metadataSecretNameForTest(instanceId)
          ? Effect.fail(
              new ServerSecretStore.SecretStoreReadError({
                resource: `secret ${name}`,
                cause: new Error("forced metadata read failure"),
              }),
            )
          : storedSecrets.get(name),
    };
    const broker = yield* makeHermesGatewayBroker.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Read Failure Hermes",
      connectorUrl: "https://t3.example.test",
    });
    yield* broker.revokeInstance(instanceId);
    yield* broker.removeInstance(instanceId);
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        [instanceId]: { driver: "hermes", displayName: "Reused Hermes", config: {} },
      },
    }));

    failMetadataReads = true;
    const restarted = yield* makeHermesGatewayBroker.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const error = yield* Effect.flip(
      restarted.createEnrollment({
        instanceId,
        nickname: "Reused Hermes",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(error.code, "persistence-failed");
    assert.equal(
      (yield* settings.getSettings).providerInstances[instanceId]?.displayName,
      "Reused Hermes",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Original Hermes", config: {} },
          },
        }),
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect("fails closed when present Hermes metadata is malformed", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    yield* secrets.set(
      metadataSecretNameForTest(instanceId),
      new TextEncoder().encode("{not-valid-json"),
    );
    const broker = yield* makeHermesGatewayBroker.pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );

    const error = yield* Effect.flip(
      broker.createEnrollment({
        instanceId,
        nickname: "Malformed Hermes",
        connectorUrl: "https://t3.example.test",
      }),
    );
    assert.equal(error.code, "persistence-failed");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "hermes", displayName: "Malformed Hermes", config: {} },
          },
        }),
        NodeServices.layer,
      ),
    ),
  ),
);
