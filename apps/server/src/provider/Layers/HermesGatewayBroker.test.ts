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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HermesDriver } from "../Drivers/HermesDriver.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import {
  HermesGatewayBroker,
  type HermesGatewayBrokerShape,
  type HermesGatewayConnectionRegistration,
  type HermesGatewayTransport,
} from "../Services/HermesGatewayBroker.ts";
import {
  HermesGatewayBrokerLive,
  hermesGatewayCredentialSecretName,
  hermesGatewayLegacyMetadataSecretName,
  makeHermesGatewayBroker,
} from "./HermesGatewayBroker.ts";

/**
 * A version this server does not speak. Expressed relative to the supported
 * version rather than as a literal, so bumping the protocol does not turn
 * these "must be rejected" cases into "is the current version" cases.
 */
const UNSUPPORTED_PROTOCOL_VERSION = HERMES_GATEWAY_PROTOCOL_VERSION + 1;

const instanceId = ProviderInstanceId.make("hermes_remote");
const otherInstanceId = ProviderInstanceId.make("hermes_other");
const defaultHermesInstanceId = ProviderInstanceId.make("hermes");

class HermesTestInstance extends Context.Service<HermesTestInstance, ProviderInstance>()(
  "t3/provider/Layers/HermesGatewayBroker.test/HermesTestInstance",
) {}

const capabilities = {
  protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
  streaming: true,
  activity: true,
  approvals: true,
  userInput: true,
  // Part of the v4 contract itself: a hello advertising `false` fails the
  // strict capabilities check and is rejected at the version gate.
  attachments: true,
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

const hermesInstances = {
  [defaultHermesInstanceId]: { driver: "hermes", displayName: "Hermes", config: {} },
  [instanceId]: { driver: "hermes", displayName: "Remote", config: {} },
  [otherInstanceId]: { driver: "hermes", displayName: "Other", config: {} },
} as const;

/**
 * Broker over the ambient settings service, so a test can assert on what the
 * broker wrote and can build a second broker over the same durable state to
 * model a server restart.
 */
const makeBroker = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  makeHermesGatewayBroker.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provide(NodeServices.layer),
  );

/**
 * Broker over an explicitly supplied settings service, so a test can interpose
 * on `getSettings` and hold a handshake at a chosen read while another
 * operation runs to completion.
 */
const makeBrokerWith = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  settingsService: ServerSettings.ServerSettingsService["Service"],
) =>
  makeHermesGatewayBroker.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    Effect.provide(NodeServices.layer),
  );

/** Ambient layer: one settings service shared by the test and its brokers. */
const testLayer = Layer.mergeAll(
  ServerSettings.layerTest({ providerInstances: hermesInstances }),
  NodeServices.layer,
);

const hello = (
  authentication: HermesGatewayConnectionHello["authentication"],
  protocolVersion: number = HERMES_GATEWAY_PROTOCOL_VERSION,
  overrides: {
    readonly model?: string;
    readonly role?: HermesGatewayConnectionHello["role"];
  } = {},
): HermesGatewayConnectionHello => ({
  type: "connection.hello",
  requestId: HermesGatewayRequestId.make(`hello-${protocolVersion}`),
  protocolVersion,
  pluginVersion: "0.2.0",
  hermesVersion: "1.0.0",
  capabilities: { ...capabilities, protocolVersion },
  authentication,
  role: overrides.role ?? "gateway",
  ...(overrides.model !== undefined ? { model: overrides.model } : {}),
});

/** Transport that records everything it is asked to do. */
const recordingTransport = () => {
  const sent: Array<HermesGatewayT3ToPluginMessage> = [];
  const closes: Array<number> = [];
  const transport: HermesGatewayTransport = {
    send: (message) => Effect.sync(() => sent.push(message)).pipe(Effect.asVoid),
    close: (code) => Effect.sync(() => closes.push(code)).pipe(Effect.asVoid),
  };
  return { sent, closes, transport };
};

const enroll = (broker: HermesGatewayBrokerShape, id: ProviderInstanceId, nickname: string) =>
  broker.createEnrollment({
    instanceId: id,
    nickname,
    connectorUrl: "https://t3.example.test",
  });

it.effect("authenticates before applying incompatible connection state", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const broker = yield* makeBroker(secrets);
    yield* enroll(broker, defaultHermesInstanceId, "Default Hermes");
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");

    const first = recordingTransport();
    const registered = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      first.transport,
    );
    assert.isTrue(registered.accepted.credential !== undefined);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");

    const second = recordingTransport();
    const replacement = yield* broker.registerConnection(
      hello({
        type: "instance-credential",
        instanceId,
        credential: registered.accepted.credential!,
      }),
      second.transport,
    );
    assert.deepEqual(first.closes, [4001]);

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
    assert.equal(second.sent.at(-1)?.type, "session.ensure");

    // A bad credential carried on an incompatible protocol version must be
    // rejected for the credential, never for the version: rejecting on version
    // first would let an unauthenticated caller knock the instance offline.
    const malicious = yield* Effect.flip(
      broker.registerConnection(
        hello(
          {
            type: "instance-credential",
            instanceId,
            credential: HermesGatewayCredential.make("not-the-real-credential"),
          },
          UNSUPPORTED_PROTOCOL_VERSION,
        ),
        second.transport,
      ),
    );
    assert.equal(malicious.code, "invalid-authentication");
    assert.deepEqual(second.closes, []);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");
    assert.isUndefined(pendingRequest.pollUnsafe());

    yield* broker.receive(replacement, {
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
            credential: registered.accepted.credential!,
          },
          UNSUPPORTED_PROTOCOL_VERSION,
        ),
        second.transport,
      ),
    );
    assert.equal(incompatible.code, "version-incompatible");
    assert.deepEqual(second.closes, [4004]);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "upgrade-required");

    const otherEnrollment = yield* enroll(broker, otherInstanceId, "Other Hermes");
    const incompatibleEnrollment = yield* Effect.flip(
      broker.registerConnection(
        hello(
          { type: "enrollment-token", token: otherEnrollment.oneTimeToken },
          UNSUPPORTED_PROTOCOL_VERSION,
        ),
        second.transport,
      ),
    );
    assert.equal(incompatibleEnrollment.code, "version-incompatible");
    const enrolledAfterUpgrade = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: otherEnrollment.oneTimeToken }),
      second.transport,
    );
    assert.equal(enrolledAfterUpgrade.instanceId, otherInstanceId);

    const revoked = yield* broker.revokeInstance(instanceId);
    assert.equal(revoked.status, "revoked");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("invalidates the previous credential when replacement enrollment begins", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");
    const { closes, transport } = recordingTransport();
    const first = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );
    const replacement = yield* enroll(broker, instanceId, "Remote Hermes");
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
  }).pipe(Effect.provide(testLayer)),
);

it.effect("accepts only the newest unconsumed enrollment token for an instance", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const older = yield* enroll(broker, instanceId, "Remote Hermes");
    const newest = yield* enroll(broker, instanceId, "Remote Hermes");
    const { transport } = recordingTransport();

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
  }).pipe(Effect.provide(testLayer)),
);

it.effect("redeems an enrollment token exactly once under concurrent redemption", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");

    const raceFirst = yield* broker
      .registerConnection(
        hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
        recordingTransport().transport,
      )
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    const raceSecond = yield* broker
      .registerConnection(
        hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
        recordingTransport().transport,
      )
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));

    const outcomes = [yield* Fiber.join(raceFirst), yield* Fiber.join(raceSecond)];
    const accepted = outcomes.filter((outcome) => outcome._tag === "Success");
    const rejected = outcomes.filter((outcome) => outcome._tag === "Failure");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
      rejected[0]?._tag === "Failure" ? rejected[0].failure.code : "",
      "enrollment-expired",
    );
  }).pipe(Effect.provide(testLayer)),
);

/**
 * Secret store that can hold the *first* `set` — the credential write at the
 * heart of the handshake — open until a test releases it. That is the exact
 * point a competing enrollment or revocation used to be able to slip past a
 * half-finished handshake.
 */
const gatedCredentialWriteSecretStore = () =>
  Effect.gen(function* () {
    const inner = makeSecretStore();
    const reachedWrite = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    let gated = false;
    const service: ServerSecretStore.ServerSecretStore["Service"] = {
      ...inner,
      set: (name, value) =>
        Effect.suspend(() => {
          if (gated) return inner.set(name, value);
          gated = true;
          return Deferred.succeed(reachedWrite, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWrite)),
            Effect.andThen(inner.set(name, value)),
          );
        }),
    };
    return { secrets: service, reachedWrite, releaseWrite } as const;
  });

// The credential write and the acceptance that follows it are the mutation
// half of the handshake. Before they were fenced by the instance lock, a
// `createEnrollment` could complete entirely inside that window: it removed the
// outgoing credential and minted a replacement token, and then the suspended
// handshake resumed and wrote a *fresh* credential for the enrollment that had
// just been superseded — leaving the old enrollee able to authenticate forever.
it.effect("does not resurrect a credential for an enrollment superseded mid-handshake", () =>
  Effect.gen(function* () {
    const { secrets, reachedWrite, releaseWrite } = yield* gatedCredentialWriteSecretStore();
    const broker = yield* makeBrokerWith(secrets, yield* ServerSettings.ServerSettingsService);
    const enrollment = yield* enroll(broker, instanceId, "Superseded Hermes");

    const handshake = yield* broker
      .registerConnection(
        hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
        recordingTransport().transport,
      )
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    // The handshake is now parked with its token already consumed, holding the
    // instance lock.
    yield* Deferred.await(reachedWrite);

    const replacement = yield* enroll(broker, instanceId, "Superseded Hermes").pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    // The replacement enrollment must not be able to interleave with the
    // handshake's mutation section: it waits for the lock instead.
    for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
    assert.isUndefined(
      replacement.pollUnsafe(),
      "a replacement enrollment must not run inside a handshake's mutation section",
    );

    yield* Deferred.succeed(releaseWrite, undefined);
    const registered = yield* Fiber.join(handshake);
    yield* Fiber.join(replacement);

    // Whichever order they serialize in, the enrollment that ran last wins: the
    // superseded enrollee's credential is gone from the store...
    assert.isTrue(
      Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))),
      "the superseded enrollment's credential must not survive the replacement",
    );
    // ...and cannot be replayed to authenticate.
    if (registered._tag === "Success" && registered.success.accepted.credential) {
      const replayed = yield* Effect.flip(
        broker.registerConnection(
          hello({
            type: "instance-credential",
            instanceId,
            credential: registered.success.accepted.credential,
          }),
          recordingTransport().transport,
        ),
      );
      assert.equal(replayed.code, "invalid-authentication");
    }
  }).pipe(Effect.provide(testLayer)),
);

// The mirror of the above for revocation. `registerConnection` used to read a
// non-revoked record, pause, and then call `connections.accept` after a
// concurrent `revokeInstance` had already persisted `revoked: true` and cleared
// the connection — re-establishing a live socket for a revoked instance that
// nothing would reap until the next reconnect.
it.effect("leaves no live connection when revocation races a handshake", () =>
  Effect.gen(function* () {
    const { secrets, reachedWrite, releaseWrite } = yield* gatedCredentialWriteSecretStore();
    const broker = yield* makeBrokerWith(secrets, yield* ServerSettings.ServerSettingsService);
    const enrollment = yield* enroll(broker, instanceId, "Revoked Race Hermes");
    const { closes, transport } = recordingTransport();

    const handshake = yield* broker
      .registerConnection(
        hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
        transport,
      )
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(reachedWrite);

    const revoke = yield* broker
      .revokeInstance(instanceId)
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;
    assert.isUndefined(
      revoke.pollUnsafe(),
      "revocation must not run inside a handshake's mutation section",
    );

    yield* Deferred.succeed(releaseWrite, undefined);
    yield* Fiber.join(handshake);
    const revoked = yield* Fiber.join(revoke);
    assert.equal(revoked._tag, "Success");

    // Serializing the two is enough: the handshake may win the lock and be
    // accepted, but revocation then runs to completion behind it and tears the
    // socket down. What must never hold is a revoked instance with a live
    // connection.
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "revoked");
    assert.isFalse(
      yield* broker.isConnected(instanceId),
      "a revoked instance must not be left connected",
    );
    assert.deepEqual(closes, [4003]);
    assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("expires enrollment tokens from memory without a redemption attempt", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");

    // Past the 10 minute TTL and past a sweep tick.
    yield* TestClock.adjust(Duration.minutes(11));

    const expired = yield* Effect.flip(
      broker.registerConnection(
        hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
        recordingTransport().transport,
      ),
    );
    assert.equal(expired.code, "enrollment-expired");
  }).pipe(Effect.provide(testLayer)),
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
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");
    const { sent, closes, transport } = recordingTransport();
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
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
      broker.registerConnection(
        hello({ type: "instance-credential", instanceId, credential }),
        recordingTransport().transport,
      ),
    );
    assert.equal(staleReconnect.code, "instance-revoked");
  }).pipe(Effect.provide(testLayer)),
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
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-broker-test-" })),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    const provider = yield* HermesTestInstance;
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");
    const { sent, transport } = recordingTransport();
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
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
    const ensure = sent.findLast(
      (message) => message.type === "session.ensure" && message.threadId === threadId,
    );
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
    const turnStart = sent.findLast(
      (message) => message.type === "turn.start" && message.threadId === threadId,
    );
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

// Reproduces the user-reported failure end to end through the REAL broker and
// the REAL adapter (earlier adapter-only tests used a fake broker and passed,
// which is why this survived): send a turn, restart the gateway, send another.
// The second turn must not be rejected with "Call session.ensure before
// starting a turn".
it.effect("resumes an existing thread after the gateway restarts", () => {
  const secrets = makeSecretStore();
  const providerLayer = Layer.effect(
    HermesTestInstance,
    HermesDriver.create({
      instanceId,
      displayName: "Restart Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }),
  ).pipe(
    Layer.provideMerge(HermesGatewayBrokerLive),
    Layer.provide(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: { driver: "hermes", displayName: "Restart", config: {} },
        },
      }),
    ),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-broker-test-" })),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const broker = yield* HermesGatewayBroker;
    const provider = yield* HermesTestInstance;
    const enrollment = yield* enroll(broker, instanceId, "Restart Hermes");
    const threadId = ThreadId.make("gateway-restart-thread");
    const sessionId = HermesGatewaySessionId.make("gateway-restart-session");

    // ── First connection: establish a session and complete a turn ──
    const first = recordingTransport();
    const firstRegistration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      first.transport,
    );
    const startSession = yield* provider.adapter
      .startSession({ threadId, providerInstanceId: instanceId, runtimeMode: "full-access" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const ensure = first.sent.at(-1);
    if (!ensure || ensure.type !== "session.ensure") {
      return yield* Effect.die(new Error("session.ensure did not reach the transport"));
    }
    yield* broker.receive(firstRegistration, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: ensure.requestId,
      threadId,
      sessionId,
      resumed: false,
    });
    yield* Fiber.join(startSession);

    // ── `hermes gateway stop` + `start`. Deliberately NOT a clean
    // offline-then-connected: under systemd the replacement socket can be
    // accepted before the dead one's close is processed, so the broker sees a
    // replacement and the instance never reports offline.

    // ── `hermes gateway start`: a NEW connection authenticates ──
    const credential = yield* secrets.get(hermesGatewayCredentialSecretName(instanceId)).pipe(
      Effect.map(Option.getOrThrow),
      Effect.map((bytes) => new TextDecoder().decode(bytes)),
    );
    const second = recordingTransport();
    const secondRegistration = yield* broker.registerConnection(
      hello({
        type: "instance-credential",
        instanceId,
        credential: HermesGatewayCredential.make(credential),
      }),
      second.transport,
    );
    // The dead socket's close lands late, after the replacement is live. It is
    // generation-fenced, so it must not retire the new connection.
    yield* broker.disconnect(firstRegistration);
    // Let the adapter observe the reconnect and re-issue session.ensure.
    //
    // Critically the reply is NOT delivered until after this settles: the
    // resume must not block the status-stream handler waiting for it. It used
    // to, and since the reply is delivered by the broker's own stream the
    // deadlock only broke on the 30s request timeout — leaving the thread with
    // no session and every later turn rejected.
    for (let i = 0; i < 40; i += 1) yield* Effect.yieldNow;

    const resumeEnsure = second.sent.find((message) => message.type === "session.ensure");
    assert.isDefined(
      resumeEnsure,
      "a gateway restart must re-issue session.ensure on the new connection",
    );
    if (!resumeEnsure || resumeEnsure.type !== "session.ensure") {
      return yield* Effect.die(new Error("unreachable"));
    }
    assert.equal(resumeEnsure.threadId, threadId);
    assert.equal(resumeEnsure.resumeSessionId, sessionId);
    yield* broker.receive(secondRegistration, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: resumeEnsure.requestId,
      threadId,
      sessionId,
      resumed: true,
    });
    for (let i = 0; i < 20; i += 1) yield* Effect.yieldNow;

    // ── The follow-up turn must reach the plugin ──
    const sendTurn = yield* provider.adapter
      .sendTurn({ threadId, input: "follow up after restart" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const turnStart = second.sent.find((message) => message.type === "turn.start");
    assert.isDefined(turnStart, "the follow-up turn must be dispatched after a gateway restart");
    if (!turnStart || turnStart.type !== "turn.start") {
      return yield* Effect.die(new Error("unreachable"));
    }
    yield* broker.receive(secondRegistration, {
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

// ── Durable config lives in settings; liveness never does ──────────

it.effect("stores durable enrollment facts in the provider instance config", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* broker.createEnrollment({
      instanceId,
      nickname: "Durable Hermes",
      connectorUrl: "https://durable.example.test",
    });

    const configured = (yield* settings.getSettings).providerInstances[instanceId];
    assert.equal(configured?.displayName, "Durable Hermes");
    assert.deepEqual(configured?.config, {
      connectorUrl: "https://durable.example.test",
      revoked: false,
    });

    yield* broker.revokeInstance(instanceId);
    assert.deepEqual((yield* settings.getSettings).providerInstances[instanceId]?.config, {
      connectorUrl: "https://durable.example.test",
      revoked: true,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("never writes liveness into settings, so reconnects cannot restart instances", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const settings = yield* ServerSettings.ServerSettingsService;
    const enrollment = yield* enroll(broker, instanceId, "Liveness Hermes");

    const beforeConnect = (yield* settings.getSettings).providerInstances[instanceId];
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      recordingTransport().transport,
    );
    yield* broker.receive(registration, {
      type: "connection.status",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      activeSessionCount: 3,
    });

    // Connecting and reporting sessions is observable on status...
    const connected = yield* broker.getInstanceStatus(instanceId);
    assert.equal(connected.status, "connected");
    assert.equal(connected.activeSessionCount, 3);
    assert.isNotNull(connected.lastConnectedAt);

    // ...but the settings envelope is unchanged, so the provider instance
    // registry sees no config change and never closes the instance scope —
    // which would otherwise stop every live Hermes session.
    assert.deepEqual((yield* settings.getSettings).providerInstances[instanceId], beforeConnect);

    yield* broker.disconnect(registration);
    assert.deepEqual((yield* settings.getSettings).providerInstances[instanceId], beforeConnect);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports liveness as offline after a restart until the plugin reconnects", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const broker = yield* makeBroker(secrets);
    const enrollment = yield* enroll(broker, instanceId, "Restart Hermes");
    yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      recordingTransport().transport,
    );
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");

    // A fresh broker over the same durable state: enrollment facts survive,
    // liveness deliberately does not.
    const restarted = yield* makeBroker(secrets);
    const status = yield* restarted.getInstanceStatus(instanceId);
    assert.equal(status.status, "offline");
    assert.equal(status.nickname, "Restart Hermes");
    assert.equal(status.connectorUrl, "https://t3.example.test");
    assert.isNull(status.lastConnectedAt);
    assert.isNull(status.model);
    assert.equal(status.activeSessionCount, 0);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("surfaces the model reported at handshake and clears it on restart", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const broker = yield* makeBroker(secrets);
    const enrollment = yield* enroll(broker, instanceId, "Model Hermes");

    assert.isNull((yield* broker.getInstanceStatus(instanceId)).model);

    yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }, undefined, {
        model: "hermes-4-preview",
      }),
      recordingTransport().transport,
    );
    assert.equal((yield* broker.getInstanceStatus(instanceId)).model, "hermes-4-preview");

    const restarted = yield* makeBroker(secrets);
    assert.isNull((yield* restarted.getInstanceStatus(instanceId)).model);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("reports a null model for a plugin that predates the field", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Legacy Model Hermes");
    yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      recordingTransport().transport,
    );
    const status = yield* broker.getInstanceStatus(instanceId);
    assert.equal(status.status, "connected");
    assert.isNull(status.model);
  }).pipe(Effect.provide(testLayer)),
);

// ── Ping loop ─────────────────────────────────────────────────────

it.effect("pings an active connection and stays connected while pongs arrive", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Ping Hermes");

    const sent: Array<HermesGatewayT3ToPluginMessage> = [];
    const closes: Array<number> = [];
    // The registration only exists after registerConnection returns, but the
    // ping loop starts inside it — so the responder waits on this gate rather
    // than racing it.
    const registrationReady = yield* Deferred.make<HermesGatewayConnectionRegistration>();
    const pongDelivered = yield* Deferred.make<void>();
    const transport: HermesGatewayTransport = {
      send: (message) =>
        Effect.gen(function* () {
          sent.push(message);
          if (message.type !== "ping") return;
          const registration = yield* Deferred.await(registrationReady);
          yield* broker.receive(registration, {
            type: "pong",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            sentAt: message.sentAt,
          });
          yield* Deferred.succeed(pongDelivered, undefined);
        }),
      close: (code) => Effect.sync(() => closes.push(code)).pipe(Effect.asVoid),
    };

    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );
    yield* Deferred.succeed(registrationReady, registration);

    yield* TestClock.adjust(Duration.seconds(25));
    yield* Deferred.await(pongDelivered);
    assert.isTrue(sent.some((message) => message.type === "ping"));
    assert.deepEqual(closes, []);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("marks a half-open connection offline after consecutive missed pongs", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Half Open Hermes");

    // A half-open socket: writes succeed, nothing ever answers.
    const { sent, closes, transport } = recordingTransport();
    yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "connected");

    const pending = yield* broker
      .request(instanceId, {
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: HermesGatewayRequestId.make("half-open-request"),
        threadId: ThreadId.make("half-open-thread"),
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;

    // Two probe cycles, each sending a ping that times out unanswered.
    yield* TestClock.adjust(Duration.seconds(90));

    assert.isTrue(sent.filter((message) => message.type === "ping").length >= 2);
    assert.deepEqual(closes, [4008]);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "offline");
    // Pending work fails immediately instead of waiting out its own timeout.
    const failure = yield* Effect.flip(Fiber.join(pending));
    assert.include(failure.detail, "stopped responding");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("stops pinging once the connection is retired", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Retired Hermes");
    const { sent, transport } = recordingTransport();
    const registration = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      transport,
    );

    yield* broker.disconnect(registration);
    const afterDisconnect = sent.length;
    // The ping fiber lives in the connection scope, so retiring the connection
    // interrupts it rather than leaving it probing a dead socket.
    yield* TestClock.adjust(Duration.minutes(2));
    assert.equal(sent.length, afterDisconnect);
  }).pipe(Effect.provide(testLayer)),
);

// ── Management operations ─────────────────────────────────────────

it.effect("renames the display label while preserving instance identity", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* enroll(broker, instanceId, "Remote Hermes");
    yield* enroll(broker, otherInstanceId, "Other Hermes");

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

    // displayName is a free-text label, exactly like every other provider:
    // reusing one is allowed, because the instance id is the identity.
    const duplicate = yield* broker.renameInstance({
      instanceId: otherInstanceId,
      nickname: "  Research Hermes  ",
    });
    assert.equal(duplicate.instanceId, otherInstanceId);
    assert.equal(duplicate.nickname, "Research Hermes");
    assert.equal((yield* broker.getInstanceStatus(instanceId)).nickname, "Research Hermes");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves concurrent provider settings edits during rename and removal", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* enroll(broker, instanceId, "Concurrent Hermes");

    yield* broker.renameInstance({ instanceId, nickname: "Concurrent Research" });
    yield* settings.updateSettingsWith((current) => ({
      providerInstances: {
        ...current.providerInstances,
        codex_concurrent: { driver: "codex", displayName: "Concurrent Codex", config: {} },
      },
    }));

    yield* broker.revokeInstance(instanceId);
    yield* broker.removeInstance(instanceId);
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
  }).pipe(Effect.provide(testLayer)),
);

// `createEnrollment`'s settings callback no-ops when the instance is gone (or
// changed driver) between its read and its write. Continuing past that meant
// minting a token `registerConnection` can only ever reject — the user is
// handed a `hermes t3 connect …` command that fails with no explanation.
it.effect("fails rather than minting a token when the instance vanishes mid-enrollment", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const inner = makeSecretStore();
    // The credential invalidation sits exactly between the read and the write,
    // so removing the instance from there lands the race deterministically.
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...inner,
      remove: (name) =>
        settings
          .updateSettingsWith((current) => {
            const providerInstances = { ...current.providerInstances };
            delete providerInstances[instanceId];
            return { providerInstances };
          })
          .pipe(Effect.ignore, Effect.andThen(inner.remove(name))),
    };
    const broker = yield* makeBrokerWith(secrets, settings);

    const error = yield* Effect.flip(enroll(broker, instanceId, "Vanishing Hermes"));
    assert.equal(error.operation, "create-enrollment");
    assert.equal(error.code, "instance-not-found");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requires revocation before removing an enrolled instance", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const broker = yield* makeBroker(secrets);
    const settings = yield* ServerSettings.ServerSettingsService;
    const enrollment = yield* enroll(broker, instanceId, "Disposable Hermes");
    yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      recordingTransport().transport,
    );

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
    // Removal drops the credential, so a stale one cannot be replayed.
    assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("removes an explicitly configured Hermes instance that was never enrolled", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    const settings = yield* ServerSettings.ServerSettingsService;

    assert.deepEqual(yield* broker.removeInstance(instanceId), { instanceId });
    assert.isUndefined((yield* settings.getSettings).providerInstances[instanceId]);
    assert.equal(
      (yield* Effect.flip(broker.getInstanceStatus(instanceId))).code,
      "instance-not-found",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lists only enrolled Hermes instances", () =>
  Effect.gen(function* () {
    const broker = yield* makeBroker(makeSecretStore());
    yield* enroll(broker, instanceId, "Listed Hermes");

    assert.deepEqual(
      (yield* broker.listInstances).map((status) => status.instanceId),
      [instanceId],
    );
  }).pipe(Effect.provide(testLayer)),
);

// ── Legacy metadata migration ─────────────────────────────────────

const legacyBlob = (metadata: Record<string, unknown>) =>
  new TextEncoder().encode(JSON.stringify(metadata));

it.effect("migrates legacy metadata into settings and deletes the secret file", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const secretName = hermesGatewayLegacyMetadataSecretName(instanceId);
    yield* secrets.set(
      secretName,
      legacyBlob({
        nickname: "Legacy Remote",
        connectorUrl: "https://legacy.example.test/api/hermes-gateway/ws",
        revoked: false,
        // Liveness from a v1 plugin. Migration must drop it rather than carry
        // it into the config envelope.
        lastSeen: {
          pluginVersion: "0.1.0",
          hermesVersion: "0.19.0",
          capabilities: {
            protocolVersion: 1,
            streaming: true,
            activity: true,
            approvals: true,
            userInput: true,
            attachments: false,
          },
          connectedAt: "2026-07-24T00:00:00.000Z",
          activeSessionCount: 0,
        },
      }),
    );
    yield* secrets.set(
      hermesGatewayCredentialSecretName(instanceId),
      new TextEncoder().encode("legacy-credential"),
    );

    const broker = yield* makeBroker(secrets);
    const settings = yield* ServerSettings.ServerSettingsService;

    assert.deepEqual((yield* settings.getSettings).providerInstances[instanceId]?.config, {
      connectorUrl: "https://legacy.example.test/api/hermes-gateway/ws",
      revoked: false,
    });

    const status = yield* broker.getInstanceStatus(instanceId);
    assert.equal(status.connectorUrl, "https://legacy.example.test/api/hermes-gateway/ws");
    assert.equal(status.status, "offline");
    // Liveness from the blob is not resurrected.
    assert.isNull(status.lastConnectedAt);
    assert.isNull(status.protocolVersion);
    assert.equal(status.activeSessionCount, 0);

    // The blob is gone, but the credential of a still-configured, unrevoked
    // instance is kept so its plugin can reconnect.
    assert.isTrue(Option.isNone(yield* secrets.get(secretName)));
    assert.isTrue(Option.isSome(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("deletes tombstoned legacy metadata and its orphaned credential", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const secretName = hermesGatewayLegacyMetadataSecretName(instanceId);
    // Shape taken from a real orphan found on disk: revoked + removed. The old
    // code only ever passed this name to get/set, never remove, so tombstones
    // leaked for the lifetime of the install.
    yield* secrets.set(
      secretName,
      legacyBlob({
        nickname: "Research Renamed",
        connectorUrl: "https://siva.example.ts.net:7446/api/hermes-gateway/ws",
        revoked: true,
        removed: true,
      }),
    );
    yield* secrets.set(
      hermesGatewayCredentialSecretName(instanceId),
      new TextEncoder().encode("orphaned-credential"),
    );

    const broker = yield* makeBroker(secrets);
    const settings = yield* ServerSettings.ServerSettingsService;

    assert.isTrue(Option.isNone(yield* secrets.get(secretName)));
    assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))));
    // A tombstone contributes nothing to settings, and the id stays reusable.
    assert.deepEqual((yield* settings.getSettings).providerInstances[instanceId]?.config, {});
    assert.isFalse(
      (yield* broker.listInstances).some((status) => status.instanceId === instanceId),
    );
  }).pipe(Effect.provide(testLayer)),
);

/**
 * Orphan cleanup can only be exercised against a real secrets directory: the
 * whole point is that these files belong to instances settings no longer
 * mentions, so they are unreachable by name and must be discovered by scanning.
 * The two blobs below are verbatim copies of orphans found on a real install.
 */
it.effect("discovers and deletes orphaned legacy metadata left on disk", () => {
  const removedInstanceId = ProviderInstanceId.make("hermes-first-hermes-demo-7f63c3052018");
  const renamedInstanceId = ProviderInstanceId.make("hermes-research-e4fcf4b39fa1");
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3code-hermes-orphan-migration-test-",
  }).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const secrets = yield* ServerSecretStore.ServerSecretStore;

    const writeOrphan = (id: ProviderInstanceId, metadata: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* secrets.set(hermesGatewayLegacyMetadataSecretName(id), legacyBlob(metadata));
        yield* secrets.set(
          hermesGatewayCredentialSecretName(id),
          new TextEncoder().encode(`credential-for-${id}`),
        );
      });

    yield* writeOrphan(removedInstanceId, {
      nickname: "First Hermes Demo",
      connectorUrl: "https://siva.otter-hawksbill.ts.net:7446/api/hermes-gateway/ws",
      revoked: true,
      lastSeen: {
        pluginVersion: "0.1.0",
        hermesVersion: "0.19.0",
        capabilities: {
          protocolVersion: 1,
          streaming: true,
          activity: true,
          approvals: true,
          userInput: true,
          attachments: false,
        },
        connectedAt: "2026-07-25T01:11:26.467Z",
        activeSessionCount: 0,
      },
      removed: true,
    });
    yield* writeOrphan(renamedInstanceId, {
      nickname: "Research Renamed",
      connectorUrl: "https://siva.otter-hawksbill.ts.net:7446/api/hermes-gateway/ws",
      revoked: true,
      removed: true,
    });

    // Neither id appears in settings, so name-based lookup alone would miss
    // both files entirely.
    yield* makeHermesGatewayBroker.pipe(
      Effect.provide(ServerSettings.layerTest({ providerInstances: {} })),
    );

    for (const id of [removedInstanceId, renamedInstanceId]) {
      assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayLegacyMetadataSecretName(id))));
      assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(id))));
    }
    const remaining = yield* fs.readDirectory(config.secretsDir);
    assert.deepEqual(
      remaining.filter((entry) => entry.includes("hermes-gateway")),
      [],
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSecretStore.layer.pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer)),
        configLayer,
        NodeServices.layer,
      ),
    ),
  );
});

it.effect("keeps legacy metadata when the settings write fails", () =>
  Effect.gen(function* () {
    const storedSecrets = makeSecretStore();
    const secretName = hermesGatewayLegacyMetadataSecretName(instanceId);
    yield* storedSecrets.set(
      secretName,
      legacyBlob({
        nickname: "Deferred Hermes",
        connectorUrl: "https://deferred.example.test",
        revoked: false,
      }),
    );

    // Deleting the blob is conditional on committing its durable equivalent,
    // so a settings failure must leave the input intact for the next boot.
    let metadataRemovals = 0;
    const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
      ...storedSecrets,
      remove: (name) =>
        name === secretName
          ? Effect.sync(() => {
              metadataRemovals += 1;
            }).pipe(Effect.andThen(storedSecrets.remove(name)))
          : storedSecrets.remove(name),
    };

    const failingSettings = Layer.effect(
      ServerSettings.ServerSettingsService,
      ServerSettings.layerTest({ providerInstances: hermesInstances }).pipe(
        Layer.build,
        Effect.map((context) => {
          const inner = Context.get(context, ServerSettings.ServerSettingsService);
          return {
            ...inner,
            updateSettingsWith: () => Effect.die(new Error("settings write failed")),
          } satisfies ServerSettings.ServerSettingsService["Service"];
        }),
      ),
    );

    yield* makeHermesGatewayBroker.pipe(
      Effect.provide(failingSettings),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );

    assert.equal(metadataRemovals, 0);
    assert.isTrue(Option.isSome(yield* storedSecrets.get(secretName)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("discards unreadable legacy metadata instead of failing boot", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    const secretName = hermesGatewayLegacyMetadataSecretName(instanceId);
    yield* secrets.set(secretName, new TextEncoder().encode("{not-valid-json"));

    const broker = yield* makeBroker(secrets);
    assert.isTrue(Option.isNone(yield* secrets.get(secretName)));
    // Boot survives; the instance is simply un-enrolled.
    assert.equal(
      (yield* Effect.flip(broker.getInstanceStatus(instanceId))).code,
      "instance-not-found",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("migrates a revoked legacy instance and drops its credential", () =>
  Effect.gen(function* () {
    const secrets = makeSecretStore();
    yield* secrets.set(
      hermesGatewayLegacyMetadataSecretName(instanceId),
      legacyBlob({
        nickname: "Revoked Legacy",
        connectorUrl: "https://revoked.example.test",
        revoked: true,
      }),
    );
    yield* secrets.set(
      hermesGatewayCredentialSecretName(instanceId),
      new TextEncoder().encode("revoked-credential"),
    );

    const broker = yield* makeBroker(secrets);
    assert.equal((yield* broker.getInstanceStatus(instanceId)).status, "revoked");
    assert.isTrue(Option.isNone(yield* secrets.get(hermesGatewayCredentialSecretName(instanceId))));

    const reconnect = yield* Effect.flip(
      broker.registerConnection(
        hello({
          type: "instance-credential",
          instanceId,
          credential: HermesGatewayCredential.make("revoked-credential"),
        }),
        recordingTransport().transport,
      ),
    );
    assert.equal(reconnect.code, "invalid-authentication");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a delivery connection never displaces the live gateway connection", () =>
  Effect.gen(function* () {
    // The failure this guards: an out-of-process cron run dials in to hand
    // over one delivery, `registerConnection` treats it as a replacement, and
    // the real plugin gets closed with 4001 — knocking Hermes offline for the
    // duration of a cron job.
    const broker = yield* makeBroker(makeSecretStore());
    const enrollment = yield* enroll(broker, instanceId, "Remote Hermes");
    const live = recordingTransport();
    const gateway = yield* broker.registerConnection(
      hello({ type: "enrollment-token", token: enrollment.oneTimeToken }),
      live.transport,
    );
    assert.equal(gateway.role, "gateway");
    assert.isTrue(yield* broker.isConnected(instanceId));

    const credential = gateway.accepted.credential!;
    const cron = recordingTransport();
    const delivery = yield* broker.registerConnection(
      hello(
        { type: "instance-credential", instanceId, credential },
        HERMES_GATEWAY_PROTOCOL_VERSION,
        { role: "delivery" },
      ),
      cron.transport,
    );

    assert.equal(delivery.role, "delivery");
    // No generation: it was never registered, so there is nothing for it to
    // be stale against — and a generation would let it be compared with, and
    // mistaken for, the live connection.
    assert.equal(delivery.generation, null);
    assert.deepEqual(live.closes, [], "the live gateway socket must not be closed");
    assert.isTrue(yield* broker.isConnected(instanceId));

    // A delivery socket holds no session, so it must not be able to answer
    // the live connection's outstanding requests — otherwise a throwaway cron
    // socket could speak for the real plugin.
    const threadId = ThreadId.make("delivery-fencing-thread");
    const pendingRequestId = HermesGatewayRequestId.make("delivery-fencing-session");
    const pending = yield* broker
      .request(instanceId, {
        type: "session.ensure",
        protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
        requestId: pendingRequestId,
        threadId,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    yield* broker.receive(delivery, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: pendingRequestId,
      threadId,
      sessionId: HermesGatewaySessionId.make("delivery-forged-session"),
      resumed: false,
    });
    yield* Effect.yieldNow;
    assert.isUndefined(
      pending.pollUnsafe(),
      "a delivery connection must not complete the live connection's requests",
    );

    // The live connection still can.
    yield* broker.receive(gateway, {
      type: "session.ready",
      protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
      requestId: pendingRequestId,
      threadId,
      sessionId: HermesGatewaySessionId.make("real-session"),
      resumed: false,
    });
    assert.equal((yield* Fiber.join(pending)).type, "session.ready");

    // Closing the delivery socket is its normal lifecycle and must leave the
    // instance's liveness untouched.
    yield* broker.disconnect(delivery);
    assert.isTrue(yield* broker.isConnected(instanceId));
    assert.deepEqual(live.closes, []);
  }).pipe(Effect.provide(testLayer)),
);
