import { MANAGED_CLOUD_SOURCE_PORT, type ManagedCloudSandboxResourceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { isPrivateNetworkHost } from "@t3tools/shared/hostClassification";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import { PortDiscovery } from "../preview/PortScanner.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as Net from "@t3tools/shared/Net";
import { baseSshArgs, buildSshHostSpecEffect, resolveSshCommand } from "@t3tools/ssh/command";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { CloudSandboxManager } from "./CloudSandboxManager.ts";
import { CloudSandboxManagerError } from "./CloudSandboxStore.ts";

export class CloudSandboxPreview extends Context.Service<
  CloudSandboxPreview,
  {
    readonly open: (input: {
      readonly resourceId: ManagedCloudSandboxResourceId;
      readonly url: string;
      readonly access?: "local" | "protected";
      readonly close?: boolean;
    }) => Effect.Effect<{ readonly url: string }, CloudSandboxManagerError>;
  }
>()("t3/cloudSandbox/CloudSandboxPreview") {}

export const make = Effect.gen(function* () {
  const manager = yield* CloudSandboxManager;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* Net.NetService;
  const sshCommand = yield* resolveSshCommand;
  const forwards = new Map<string, { port: number; scope: Scope.Closeable }>();
  const client = yield* HttpClient.HttpClient;
  return CloudSandboxPreview.of({
    open: Effect.fn("CloudSandboxPreview.open")(function* (input) {
      const url = yield* Effect.try({
        try: () => new URL(input.url),
        catch: () => new CloudSandboxManagerError({ reason: "ownership" }),
      });
      if (input.close) {
        for (const [key, forward] of forwards) {
          if (
            key.startsWith(`${input.resourceId}:`) &&
            url.hostname === "127.0.0.1" &&
            Number(url.port) === forward.port
          ) {
            yield* Scope.close(forward.scope, Exit.void);
            return { url: input.url };
          }
        }
        return { url: input.url };
      }
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname) ||
        url.username ||
        url.password ||
        port === MANAGED_CLOUD_SOURCE_PORT
      )
        return yield* new CloudSandboxManagerError({ reason: "ownership" });
      const route = yield* manager.route(input.resourceId);
      if (port === Number(new URL(route.httpBaseUrl).port))
        return yield* new CloudSandboxManagerError({ reason: "ownership" });
      const response = yield* client
        .execute(
          HttpClientRequest.get(
            new URL("/api/cloud-sandboxes/preview-ports", route.httpBaseUrl).toString(),
          ).pipe(HttpClientRequest.bearerToken(route.connection.bearerToken)),
        )
        .pipe(Effect.mapError(() => new CloudSandboxManagerError({ reason: "transport" })));
      if (response.status !== 200)
        return yield* new CloudSandboxManagerError({ reason: "ownership" });
      const ports = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Int))),
        Effect.mapError(() => new CloudSandboxManagerError({ reason: "ownership" })),
      );
      if (!ports.includes(port))
        return yield* new CloudSandboxManagerError({ reason: "ownership" });
      if (input.access === "local") {
        const localPort = yield* manager
          .withConnection(input.resourceId, (target) =>
            Effect.gen(function* () {
              const reserved = yield* net.reserveLoopbackPort();
              const key = `${input.resourceId}:${reserved}`;
              const args = [
                ...baseSshArgs(target, { batchMode: "yes" }),
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-N",
                "-L",
                `127.0.0.1:${reserved}:127.0.0.1:${port}`,
                "--",
                yield* buildSshHostSpecEffect(target),
              ];
              const scope = yield* Scope.fork(yield* Scope.Scope);
              yield* spawner
                .spawn(ChildProcess.make(sshCommand, args))
                .pipe(Effect.provideService(Scope.Scope, scope));
              yield* waitForHttpReady({
                baseUrl: `${url.protocol}//127.0.0.1:${reserved}`,
                timeoutMs: 10_000,
                makeError: () => new CloudSandboxManagerError({ reason: "transport" }),
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, client),
                Effect.onExit((exit) =>
                  Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
                ),
              );
              forwards.set(key, { port: reserved, scope });
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  forwards.delete(key);
                }),
              ).pipe(Effect.provideService(Scope.Scope, scope));
              return reserved;
            }),
          )
          .pipe(Effect.mapError(() => new CloudSandboxManagerError({ reason: "transport" })));
        url.hostname = "127.0.0.1";
        url.port = String(localPort);
        return { url: url.toString() };
      }
      const hosted = yield* manager.execute(input.resourceId, {
        _tag: "host",
        port,
        isPublic: false,
      });
      if (hosted._tag !== "host" || hosted.port.isPublic)
        return yield* new CloudSandboxManagerError({ reason: "provider" });
      const target = yield* Effect.try({
        try: () => new URL(hosted.port.url),
        catch: () => new CloudSandboxManagerError({ reason: "provider" }),
      });
      if (target.protocol !== "https:" || isPrivateNetworkHost(target.hostname))
        return yield* new CloudSandboxManagerError({ reason: "provider" });
      target.pathname = `${target.pathname.replace(/\/$/u, "")}${url.pathname}`;
      // Provider access tokens and the application's query both belong in the opened URL.
      for (const [key, value] of url.searchParams) target.searchParams.append(key, value);
      target.hash = url.hash;
      return { url: target.toString() };
    }),
  });
});
export const layer = Layer.effect(CloudSandboxPreview, make);

export const discoveredPorts = Effect.fn("CloudSandboxPreview.discoveredPorts")(function* () {
  const discovery = yield* PortDiscovery;
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  const runtimePort = Option.isSome(runtimeState) ? runtimeState.value.port : null;
  return (yield* discovery.scan())
    .filter(
      (server) =>
        server.port !== config.port &&
        server.port !== runtimePort &&
        server.port !== MANAGED_CLOUD_SOURCE_PORT,
    )
    .map((server) => server.port);
});
