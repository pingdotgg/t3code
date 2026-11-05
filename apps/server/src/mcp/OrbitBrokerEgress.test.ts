// @effect-diagnostics nodeBuiltinImport:off -- Real sockets, to observe what the transport sends.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Undici from "undici";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrbitBroker from "./OrbitBroker.ts";

// A module namespace is read-only; the CommonJS export is what node:http reads its global agent from.
const httpExports = NodeModule.createRequire(import.meta.url)("node:http") as {
  globalAgent: NodeHttp.Agent;
};

const environmentId = EnvironmentId.make("environment:orbit");
const threadId = ThreadId.make("work-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "session",
  issuedAt: 1,
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  capabilities: new Set(["orchestration"]),
};

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const call = Effect.fnUntraced(function* (port: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const tokenFile = yield* fileSystem.makeTempFileScoped();
  yield* fileSystem.writeFileString(tokenFile, "broker-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  yield* fileSystem.chmod(tokenFile, 0o600);
  const broker = yield* OrbitBroker.OrbitBroker.pipe(
    Effect.provide(
      OrbitBroker.layer.pipe(
        Layer.provide(OrbitBroker.layerLoopbackTransport),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({})),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          }),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { T3CODE_ORBIT_BROKER_TOKEN_FILE: tokenFile, T3CODE_ORBIT_PORT: String(port) },
            }),
          ),
        ),
      ),
    ),
  );
  return yield* broker
    .invoke({ operation: "start_thread", arguments: { prompt: "confidential prompt" } })
    .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope), Effect.exit);
});

it.layer(NodeServices.layer)("Orbit broker egress", (it) => {
  it.effect("does not follow a redirect that would resend the prompt to another host", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const elsewhere: string[] = [];
        const remote = yield* listen((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => {
            elsewhere.push(body);
            response.end("{}");
          });
        });
        const orbit = yield* listen((_request, response) => {
          response.writeHead(307, { location: `http://127.0.0.1:${remote}/collect` });
          response.end("{}");
        });
        const exit = yield* call(orbit);
        expect(exit._tag).toBe("Failure");
        expect(elsewhere).toEqual([]);
      }),
    ),
  );

  it.effect("reaches loopback directly when the process is configured for an env proxy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let proxied = 0;
        const proxy = yield* listen((_request, response) => {
          proxied++;
          response.end("{}");
        });
        const orbit = yield* listen((_request, response) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ direct: true }));
        });
        const proxyUrl = `http://127.0.0.1:${proxy}`;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const dispatcher = Undici.getGlobalDispatcher();
            const agent = httpExports.globalAgent;
            Undici.setGlobalDispatcher(
              new Undici.EnvHttpProxyAgent({ httpProxy: proxyUrl, noProxy: "" }),
            );
            httpExports.globalAgent = new NodeHttp.Agent({
              proxyEnv: { HTTP_PROXY: proxyUrl },
            });
            return { dispatcher, agent };
          }),
          ({ dispatcher, agent }) =>
            Effect.sync(() => {
              Undici.setGlobalDispatcher(dispatcher);
              httpExports.globalAgent = agent;
            }),
        );
        const exit = yield* call(orbit);
        expect(exit).toMatchObject({ _tag: "Success", value: { direct: true } });
        expect(proxied).toBe(0);
      }),
    ),
  );
});
