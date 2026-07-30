import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_HERMES_MODEL,
  HERMES_GATEWAY_PROTOCOL_VERSION,
  ProviderInstanceId,
  type HermesGatewayInstanceStatus,
  type HermesGatewayModelsListResponse,
  type HermesGatewayT3ToPluginMessage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { HermesGatewayBroker } from "../Services/HermesGatewayBroker.ts";
import { decodeHermesModelSlug } from "../hermesModels.ts";
import { HermesDriver } from "./HermesDriver.ts";

const instanceId = ProviderInstanceId.make("hermes_catalog_test");

const connectedStatus: HermesGatewayInstanceStatus = {
  instanceId,
  nickname: "Catalog Hermes",
  status: "connected",
  connectorUrl: "wss://hermes.example.test/api/hermes-gateway/ws",
  lastConnectedAt: null,
  pluginVersion: "0.5.0",
  hermesVersion: "0.19.0",
  model: "anthropic/claude-sonnet-4",
  connectionGeneration: 7,
  activeSessionCount: 0,
  protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
  capabilities: {
    protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
    streaming: true,
    activity: true,
    approvals: true,
    userInput: true,
    attachments: true,
  },
};

type ModelsListRequest = Extract<
  HermesGatewayT3ToPluginMessage,
  { readonly type: "models.list.request" }
>;

const catalogResponse = (
  request: ModelsListRequest,
  model: string,
): HermesGatewayModelsListResponse => ({
  type: "models.list.response",
  protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
  requestId: request.requestId,
  currentProvider: "anthropic",
  currentModel: model,
  currentReasoningEffort: "high",
  reasoningEfforts: ["none", "low", "high"],
  models: [
    {
      provider: "anthropic",
      providerName: "Anthropic",
      model,
      supportsReasoning: true,
    },
  ],
});

const testLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-driver-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providerInstances: {
          [instanceId]: { driver: "hermes", displayName: "Catalog Hermes", config: {} },
        },
      }),
    ),
  );

it.effect("discovers the Hermes model catalog without blocking snapshots", () =>
  Effect.gen(function* () {
    const releaseCatalog = yield* Deferred.make<void>();
    const requests: Array<HermesGatewayT3ToPluginMessage> = [];
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(connectedStatus),
      isConnected: () => Effect.succeed(true),
      request: (_requestedInstanceId, message) =>
        Effect.gen(function* () {
          if (message.type !== "models.list.request") {
            return yield* Effect.die(
              new Error(`Unexpected Hermes gateway request '${message.type}'.`),
            );
          }
          requests.push(message);
          yield* Deferred.await(releaseCatalog);
          return {
            type: "models.list.response",
            protocolVersion: HERMES_GATEWAY_PROTOCOL_VERSION,
            requestId: message.requestId,
            currentProvider: "anthropic",
            currentModel: "anthropic/claude-sonnet-4",
            currentReasoningEffort: "high",
            reasoningEfforts: ["none", "low", "high"],
            models: [
              {
                provider: "anthropic",
                providerName: "Anthropic",
                model: "anthropic/claude-sonnet-4",
                supportsReasoning: true,
              },
              {
                provider: "openrouter",
                providerName: "OpenRouter",
                model: "openai/gpt-5.4",
                supportsReasoning: true,
              },
            ],
          } satisfies HermesGatewayModelsListResponse;
        }),
      streamStatuses: Stream.empty,
    } satisfies typeof defaultBroker;

    const provider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(Effect.provideService(HermesGatewayBroker, broker));

    // The inventory request is deliberately parked. A snapshot must still be
    // available immediately with the stable default model sentinel.
    const initial = yield* provider.snapshot.getSnapshot;
    expect(initial.models).toHaveLength(1);
    expect(initial.models[0]?.slug).toBe(DEFAULT_HERMES_MODEL);
    expect(initial.models[0]?.name).toBe("anthropic/claude-sonnet-4 (Hermes default)");

    // Repeated reads in one connection generation share the in-flight
    // discovery rather than issuing a request per status consumer.
    yield* provider.snapshot.getSnapshot;
    yield* Effect.yieldNow;
    expect(requests.map((request) => request.type)).toEqual(["models.list.request"]);

    const catalogUpdate = yield* Stream.runHead(provider.snapshot.streamChanges).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseCatalog, undefined);

    const updated = Option.getOrThrow(yield* Fiber.join(catalogUpdate));
    expect(updated.models.map((model) => model.name)).toEqual([
      "anthropic/claude-sonnet-4 (Hermes default)",
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.4",
    ]);
    expect(decodeHermesModelSlug(updated.models[1]?.slug ?? "")).toEqual({
      mode: "specific",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4",
    });
    expect(decodeHermesModelSlug(updated.models[2]?.slug ?? "")).toEqual({
      mode: "specific",
      provider: "openrouter",
      model: "openai/gpt-5.4",
    });
    expect(updated.models[2]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
    });
    expect(updated.models[2]?.capabilities?.optionDescriptors?.[0]).not.toHaveProperty(
      "currentValue",
    );
    expect(requests).toHaveLength(1);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("retries a transient Hermes model catalog failure with bounded backoff", () =>
  Effect.gen(function* () {
    const requests: Array<ModelsListRequest> = [];
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(connectedStatus),
      isConnected: () => Effect.succeed(true),
      request: (_requestedInstanceId, message) =>
        Effect.gen(function* () {
          if (message.type !== "models.list.request") {
            return yield* Effect.die(
              new Error(`Unexpected Hermes gateway request '${message.type}'.`),
            );
          }
          requests.push(message);
          if (requests.length === 1) {
            return yield* new ProviderAdapterRequestError({
              provider: "hermes",
              method: message.type,
              detail: "temporary gateway failure",
            });
          }
          return catalogResponse(message, "anthropic/claude-opus-4");
        }),
      streamStatuses: Stream.empty,
    } satisfies typeof defaultBroker;

    const provider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(Effect.provideService(HermesGatewayBroker, broker));
    const catalogUpdate = yield* Stream.runHead(provider.snapshot.streamChanges).pipe(
      Effect.forkChild({ startImmediately: true }),
    );

    const initial = yield* provider.snapshot.getSnapshot;
    expect(initial.models).toHaveLength(1);
    yield* Effect.yieldNow;
    expect(requests).toHaveLength(1);

    yield* TestClock.adjust("249 millis");
    expect(requests).toHaveLength(1);
    yield* TestClock.adjust("1 millis");

    const updated = Option.getOrThrow(yield* Fiber.join(catalogUpdate));
    expect(requests).toHaveLength(2);
    expect(updated.models.map((model) => model.name)).toContain("anthropic/claude-opus-4");

    yield* TestClock.adjust("5 seconds");
    expect(requests).toHaveLength(2);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("fences a pending retry when the Hermes connection generation changes", () =>
  Effect.gen(function* () {
    let status = connectedStatus;
    const requestGenerations: Array<number | null> = [];
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(status),
      isConnected: () => Effect.succeed(true),
      request: (_requestedInstanceId, message) =>
        Effect.gen(function* () {
          if (message.type !== "models.list.request") {
            return yield* Effect.die(
              new Error(`Unexpected Hermes gateway request '${message.type}'.`),
            );
          }
          requestGenerations.push(status.connectionGeneration);
          if (status.connectionGeneration === connectedStatus.connectionGeneration) {
            return yield* new ProviderAdapterRequestError({
              provider: "hermes",
              method: message.type,
              detail: "old connection failed",
            });
          }
          return catalogResponse(message, "anthropic/claude-generation-8");
        }),
      streamStatuses: Stream.empty,
    } satisfies typeof defaultBroker;

    const provider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(Effect.provideService(HermesGatewayBroker, broker));
    yield* provider.snapshot.getSnapshot;
    yield* Effect.yieldNow;
    expect(requestGenerations).toEqual([7]);

    status = {
      ...connectedStatus,
      model: "anthropic/claude-generation-8",
      connectionGeneration: 8,
    };
    const catalogUpdate = yield* Stream.runHead(provider.snapshot.streamChanges).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* provider.snapshot.getSnapshot;

    const updated = Option.getOrThrow(yield* Fiber.join(catalogUpdate));
    expect(updated.models.map((model) => model.name)).toContain("anthropic/claude-generation-8");
    yield* TestClock.adjust("5 seconds");
    expect(requestGenerations).toEqual([7, 8]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("ignores an older same-generation response after a forced refresh", () =>
  Effect.gen(function* () {
    const releaseFirstRequest = yield* Deferred.make<void>();
    const requests: Array<ModelsListRequest> = [];
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(connectedStatus),
      isConnected: () => Effect.succeed(true),
      request: (_requestedInstanceId, message) =>
        Effect.gen(function* () {
          if (message.type !== "models.list.request") {
            return yield* Effect.die(
              new Error(`Unexpected Hermes gateway request '${message.type}'.`),
            );
          }
          requests.push(message);
          if (requests.length === 1) {
            yield* Deferred.await(releaseFirstRequest);
            return catalogResponse(message, "anthropic/stale-model");
          }
          return catalogResponse(message, "anthropic/refreshed-model");
        }),
      streamStatuses: Stream.empty,
    } satisfies typeof defaultBroker;

    const provider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(Effect.provideService(HermesGatewayBroker, broker));
    yield* provider.snapshot.getSnapshot;
    yield* Effect.yieldNow;
    expect(requests).toHaveLength(1);

    const catalogUpdate = yield* Stream.runHead(provider.snapshot.streamChanges).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.yieldNow;
    yield* provider.snapshot.refresh;

    const refreshed = Option.getOrThrow(yield* Fiber.join(catalogUpdate));
    expect(requests).toHaveLength(2);
    expect(refreshed.models.map((model) => model.name)).toContain("anthropic/refreshed-model");

    yield* Deferred.succeed(releaseFirstRequest, undefined);
    yield* Effect.yieldNow;
    const afterStaleResponse = yield* provider.snapshot.getSnapshot;
    expect(afterStaleResponse.models.map((model) => model.name)).toContain(
      "anthropic/refreshed-model",
    );
    expect(afterStaleResponse.models.map((model) => model.name)).not.toContain(
      "anthropic/stale-model",
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("uses a distinct catalog request namespace after an instance rebuild", () =>
  Effect.gen(function* () {
    const requests: Array<ModelsListRequest> = [];
    const firstRequestSeen = yield* Deferred.make<void>();
    const secondRequestSeen = yield* Deferred.make<void>();
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(connectedStatus),
      isConnected: () => Effect.succeed(true),
      request: (_requestedInstanceId, message) =>
        Effect.gen(function* () {
          if (message.type !== "models.list.request") {
            return yield* Effect.die(
              new Error(`Unexpected Hermes gateway request '${message.type}'.`),
            );
          }
          requests.push(message);
          yield* Deferred.succeed(
            requests.length === 1 ? firstRequestSeen : secondRequestSeen,
            undefined,
          );
          return catalogResponse(message, "anthropic/claude-sonnet-4");
        }),
      streamStatuses: Stream.empty,
    } satisfies typeof defaultBroker;

    const firstScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
    const firstProvider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
      Effect.provideService(Scope.Scope, firstScope),
    );
    yield* firstProvider.snapshot.getSnapshot;
    yield* Deferred.await(firstRequestSeen);
    yield* Scope.close(firstScope, Exit.void);

    const secondScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
    const secondProvider = yield* HermesDriver.create({
      instanceId,
      displayName: "Catalog Hermes rebuilt",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
      Effect.provideService(Scope.Scope, secondScope),
    );
    yield* secondProvider.snapshot.getSnapshot;
    yield* Deferred.await(secondRequestSeen);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.requestId).not.toBe(requests[1]?.requestId);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("ends the old status stream when an instance scope closes", () =>
  Effect.gen(function* () {
    const firstUpdateSeen = yield* Deferred.make<void>();
    let updateCount = 0;
    const defaultBroker = yield* HermesGatewayBroker;
    const broker = {
      ...defaultBroker,
      getInstanceStatus: () => Effect.succeed(connectedStatus),
      isConnected: () => Effect.succeed(false),
      request: () => Effect.die(new Error("offline snapshots must not request a catalog")),
      // Model the broker's process-lifetime stream: emit one status so the old
      // subscription is demonstrably active, then remain open forever.
      streamStatuses: Stream.concat(Stream.make(connectedStatus), Stream.never),
    } satisfies typeof defaultBroker;
    const instanceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(instanceScope, Exit.void));
    const provider = yield* HermesDriver.create({
      instanceId,
      displayName: "Old Catalog Hermes",
      environment: [],
      enabled: true,
      config: HermesDriver.defaultConfig(),
    }).pipe(
      Effect.provideService(HermesGatewayBroker, broker),
      Effect.provideService(Scope.Scope, instanceScope),
    );
    const oldSubscription = yield* Stream.runForEach(provider.snapshot.streamChanges, () =>
      Effect.sync(() => {
        updateCount += 1;
      }).pipe(Effect.andThen(Deferred.succeed(firstUpdateSeen, undefined)), Effect.ignore),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(firstUpdateSeen);
    yield* Scope.close(instanceScope, Exit.void);
    yield* Fiber.join(oldSubscription);
    // A registry rebuild reuses this process-wide source. Completion here
    // proves the old driver's consumer cannot later overwrite its replacement.
    expect(updateCount).toBe(1);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
