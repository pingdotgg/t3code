import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ManagedCloudSandboxResourceId,
  ManagedCloudSandboxOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as CloudSandboxDirectory from "./cloudSandboxDirectory.ts";
import { loadEnvironmentSandboxStatus } from "./cloudSandbox.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import {
  BearerConnectionTarget,
  CloudSandboxConnectionTarget,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  BearerConnectionProfile,
  CloudSandboxConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import type { RpcSession } from "../rpc/session.ts";

const decodeManagedCloudSandboxOperation = Schema.decodeUnknownSync(ManagedCloudSandboxOperation);

it.effect("shares controller ownership discovery across sandbox status reads", () =>
  Effect.gen(function* () {
    const controllerId = EnvironmentId.make("controller");
    const first = EnvironmentId.make("first");
    const second = EnvironmentId.make("second");
    const target = new PrimaryConnectionTarget({
      environmentId: controllerId,
      label: "Controller",
      httpBaseUrl: "http://controller.test",
      wsBaseUrl: "ws://controller.test",
    });
    const prepared: PreparedConnection = {
      environmentId: controllerId,
      label: "Controller",
      httpBaseUrl: "http://controller.test",
      socketUrl: "ws://controller.test/ws",
      target,
      httpAuthorization: null,
    };
    const sandboxEntry = (id: EnvironmentId): ConnectionCatalogEntry => {
      const connectionId = `cloud-sandbox:${controllerId}:${id}`;
      return {
        target: new CloudSandboxConnectionTarget({
          environmentId: id,
          label: id,
          connectionId,
          driverKind: "boat",
          sandboxId: id,
        }),
        profile: Option.some(
          new CloudSandboxConnectionProfile({
            connectionId,
            environmentId: id,
            label: id,
            driverKind: "boat",
            sandboxId: id,
            resourceId: ManagedCloudSandboxResourceId.make(id),
            controller: target,
          }),
        ),
        enabled: true,
      };
    };
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [controllerId, { target, profile: Option.none(), enabled: true }],
        [first, sandboxEntry(first)],
        [second, sandboxEntry(second)],
      ]),
    );
    const connection = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some(prepared),
    );
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
      desired: true,
      network: "online",
      phase: "connected",
      stage: null,
      attempt: 0,
      generation: 1,
      lastFailure: null,
      retryAt: null,
    });
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
    let lists = 0;
    const client = HttpClient.make((request) => {
      const body = decodeManagedCloudSandboxOperation(
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : {},
      );
      if (body._tag === "list") {
        lists++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              _tag: "list",
              resources: [first, second].map((id) => ({
                resourceId: ManagedCloudSandboxResourceId.make(id),
                controllerEnvironmentId: controllerId,
                driverKind: "boat",
                sandboxId: id,
                parentResourceId: null,
                phase: "connected",
                environmentId: id,
                label: id,
                recordingIds: [],
              })),
            }),
          ),
        );
      }
      if (body._tag !== "execute") return Effect.die("Expected a sandbox status request");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            _tag: "result",
            result: {
              _tag: "status",
              sandbox: {
                sandboxId: body.resourceId,
                driverKind: "boat",
                name: body.resourceId,
                state: "ready",
                size: "small",
                autoStopDeadline: null,
                createdAt: "2026-01-01T00:00:00Z",
              },
              capabilities: {
                diskForking: true,
                desktopStreaming: true,
                autoStopKeepalive: true,
                publicPortHosting: true,
                hotResize: false,
                rootAccess: true,
              },
            },
          }),
        ),
      );
    });
    const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries,
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      run: (_environmentId, effect) =>
        effect.pipe(
          Effect.provide(
            Layer.mock(EnvironmentSupervisor.EnvironmentSupervisor)({
              target,
              state,
              session,
              prepared: connection,
            }),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      yield* loadEnvironmentSandboxStatus(first);
      yield* loadEnvironmentSandboxStatus(second);
    }).pipe(
      Effect.provide(CloudSandboxDirectory.layer.pipe(Layer.provide(registry))),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    expect(lists).toBe(1);
  }),
);

it.effect("a plain bearer environment is never looked up as a sandbox", () =>
  Effect.gen(function* () {
    const controllerId = EnvironmentId.make("controller");
    const bearerId = EnvironmentId.make("bearer");
    const connectionId = `bearer:${bearerId}:http://bearer.test`;
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          bearerId,
          {
            target: new BearerConnectionTarget({
              environmentId: bearerId,
              label: "Bearer",
              connectionId,
            }),
            profile: Option.some(
              new BearerConnectionProfile({
                connectionId,
                environmentId: bearerId,
                label: "Bearer",
                httpBaseUrl: "http://bearer.test",
                wsBaseUrl: "ws://bearer.test",
              }),
            ),
            enabled: true,
          },
        ],
        [
          controllerId,
          {
            target: new PrimaryConnectionTarget({
              environmentId: controllerId,
              label: "Controller",
              httpBaseUrl: "http://controller.test",
              wsBaseUrl: "ws://controller.test",
            }),
            profile: Option.none(),
            enabled: true,
          },
        ],
      ]),
    );
    let requests = 0;
    const client = HttpClient.make(() => {
      requests++;
      return Effect.die("No HTTP request expected");
    });
    const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries,
      networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
      run: () => Effect.die("No controller lookup expected"),
    });
    const status = yield* loadEnvironmentSandboxStatus(bearerId).pipe(
      Effect.provide(CloudSandboxDirectory.layer.pipe(Layer.provide(registry))),
      Effect.provideService(HttpClient.HttpClient, client),
    );
    expect(status).toBeNull();
    expect(requests).toBe(0);
  }),
);
