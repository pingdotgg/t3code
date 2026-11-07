import { expect, it } from "@effect/vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LanGateway from "./LanGateway.ts";

const self: ExecutionEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("env_self"),
  label: "Self",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
};

const peerDescriptorBody = JSON.stringify({
  environmentId: "env_peer",
  label: "Peer",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
});

const gatewayLayer = (options?: {
  readonly lanGatewayEnabled?: boolean;
  readonly http?: HttpClient.HttpClient;
}) =>
  LanGateway.layer.pipe(
    Layer.provideMerge(
      ServerSettings.layerTest({ lanGatewayEnabled: options?.lanGatewayEnabled ?? true }),
    ),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(self.environmentId),
        getDescriptor: Effect.succeed(self),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        options?.http ??
          HttpClient.make((request, _url, _signal) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(peerDescriptorBody, {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );

it.effect("rejects a public hostname on add", () =>
  Effect.gen(function* () {
    const gateway = yield* LanGateway.LanGateway;
    const error = yield* gateway.add({ url: "https://example.com" }).pipe(Effect.flip);
    expect(error._tag).toBe("LanGatewayError");
    expect(error.reason).toBe("not_private");
  }).pipe(Effect.provide(gatewayLayer())),
);

it.effect("adds a private peer after probing its descriptor", () =>
  Effect.gen(function* () {
    const gateway = yield* LanGateway.LanGateway;
    const peer = yield* gateway.add({ url: "http://192.168.1.20:13773" });
    expect(peer).toEqual({
      environmentId: EnvironmentId.make("env_peer"),
      label: "Peer",
      httpBaseUrl: "http://192.168.1.20:13773",
    });
    expect(yield* gateway.list).toEqual([peer]);
    expect(yield* gateway.advertise).toEqual([
      { environmentId: peer.environmentId, label: peer.label },
    ]);
    expect(yield* gateway.resolveUpstream(peer.environmentId)).toEqual(
      Option.some(peer.httpBaseUrl),
    );
  }).pipe(Effect.provide(gatewayLayer())),
);

it.effect("keeps an add that lands between subscribing and reading the stream", () =>
  Effect.gen(function* () {
    const gateway = yield* LanGateway.LanGateway;
    const changes = yield* gateway.subscribeAdvertisementChanges;
    const peer = yield* gateway.add({ url: "http://192.168.1.20:13773" });
    const [advertised] = yield* changes.pipe(Stream.take(1), Stream.runCollect);
    expect(advertised).toEqual([{ environmentId: peer.environmentId, label: peer.label }]);
  }).pipe(Effect.scoped, Effect.provide(gatewayLayer())),
);

it.effect("refuses add and list when the gateway is disabled", () =>
  Effect.gen(function* () {
    const gateway = yield* LanGateway.LanGateway;
    const error = yield* gateway.add({ url: "http://10.0.0.2:13773" }).pipe(Effect.flip);
    expect(error.reason).toBe("disabled");
    const listError = yield* gateway.list.pipe(Effect.flip);
    expect(listError.reason).toBe("disabled");
    expect(yield* gateway.advertise).toEqual([]);
    expect(yield* gateway.resolveUpstream(EnvironmentId.make("env_peer"))).toEqual(Option.none());
  }).pipe(Effect.provide(gatewayLayer({ lanGatewayEnabled: false }))),
);
