import * as CloudSandboxPreview from "./CloudSandboxPreview.ts";
import { PortDiscovery } from "../preview/PortScanner.ts";
import * as Context from "effect/Context";
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  ManagedCloudSandboxResourceId,
  SandboxProfileId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { CloudSandboxManager } from "./CloudSandboxManager.ts";
import { fixture } from "./CloudSandboxManager.testkit.ts";
import * as Routes from "./ManagedCloudSandboxRoutes.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-managed-cloud-routes-" })),
);

it.live(
  "requires controller permissions for reconnect and never starts resources from proxy reads",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const f = fixture();
      const manager = yield* f.manager;
      const requests: Array<{
        url: string;
        authorization: string | undefined;
        cookie: string | undefined;
        headers: Record<string, string>;
      }> = [];
      const client = HttpClient.make((request) => {
        requests.push({
          url: request.url,
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          headers: { ...request.headers },
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("child", { headers: { "set-cookie": "must-not-escape=1" } }),
          ),
        );
      });
      const config = Context.get(
        yield* Layer.build(ServerConfig.layerTest(process.cwd(), { prefix: "preview-routes-" })),
        ServerConfig.ServerConfig,
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const requestContext = Context.make(CloudSandboxManager, manager).pipe(
        Context.add(FileSystem.FileSystem, fileSystem),
        Context.add(EnvironmentAuth.EnvironmentAuth, auth),
        Context.add(HttpClient.HttpClient, client),
        Context.add(ServerConfig.ServerConfig, config),
        Context.add(CloudSandboxPreview.CloudSandboxPreview, {
          open: () => Effect.die("unauthorized preview must not run"),
        }),
        Context.add(PortDiscovery, {
          scan: () => Effect.succeed([]),
          subscribe: () => Effect.void,
          retain: Effect.void,
          registerTerminalProcesses: () => Effect.void,
          unregisterTerminal: () => Effect.void,
          trackAgent: () => () => {},
          stopServer: () => Effect.void,
        }),
      );
      const web = HttpRouter.toWebHandler(Routes.layer, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
      const read = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
      const rejected = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${read.token}` },
            body: JSON.stringify({ _tag: "connect", resourceId: "test" }),
          }),
          requestContext,
        ),
      );
      expect(rejected.status).toBe(403);
      const deniedDesktop = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${read.token}` },
            body: JSON.stringify({
              _tag: "execute",
              resourceId: "test",
              operation: { _tag: "desktop" },
            }),
          }),
          requestContext,
        ),
      );
      expect(deniedDesktop.status).toBe(403);
      const deniedPreview = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed/preview", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${read.token}` },
            body: JSON.stringify({ resourceId: "test", url: "http://localhost:5173/" }),
          }),
          requestContext,
        ),
      );
      expect(deniedPreview.status).toBe(403);
      const anonymous = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ _tag: "list" }),
          }),
          requestContext,
        ),
      );
      expect(anonymous.status).toBe(401);
      const anonymousMalformedBody = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not-valid-json",
          }),
          requestContext,
        ),
      );
      expect(anonymousMalformedBody.status).toBe(401);
      const offline = yield* Effect.promise(() =>
        web.handler(
          new Request(
            "http://controller.test/api/cloud-sandboxes/managed/test/proxy/.well-known/t3/environment",
          ),
          requestContext,
        ),
      );
      expect(offline.status).toBe(503);
      expect(f.connections()).toBe(0);
      expect(requests).toHaveLength(0);
      const usedMethods: string[] = [];
      const trackedManager = new Proxy(manager, {
        get: (target, key, receiver) => {
          const value = Reflect.get(target, key, receiver);
          if (typeof key !== "string" || typeof value !== "function") return value;
          return (...args: unknown[]) => {
            usedMethods.push(key);
            return Reflect.apply(value, target, args);
          };
        },
      });
      const unknownProxy = yield* Effect.promise(() =>
        web.handler(
          new Request(
            "http://controller.test/api/cloud-sandboxes/managed/never-provisioned/proxy/api/auth/session",
          ),
          requestContext.pipe(Context.add(CloudSandboxManager, trackedManager)),
        ),
      );
      expect(unknownProxy.status).toBe(503);
      expect(usedMethods).toEqual(["route"]);
      expect(f.connections()).toBe(0);
      const id = ManagedCloudSandboxResourceId.make("test");
      yield* manager.provision({
        operationId: id,
        profile: SandboxProfileId.make("fixture"),
        sandbox: { name: "test", size: "small", autoStopMinutes: 15 },
      });
      const wrongSourceMalformedBody = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/source", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-t3-cloud-resource": "test",
              authorization: "Bearer wrong-grant-token",
            },
            body: "{not-valid-json",
          }),
          requestContext,
        ),
      );
      expect(wrongSourceMalformedBody.status).toBe(403);
      const forwarded = yield* Effect.promise(() =>
        web.handler(
          new Request(
            "http://controller.test/api/cloud-sandboxes/managed/test/proxy/api/auth/session",
            {
              headers: {
                authorization: "Bearer child-session",
                cookie: "controller-cookie=secret",
                connection: "x-hop-secret, keep-alive",
                "x-hop-secret": "must-not-forward",
                "x-forwarded-for": "203.0.113.9",
                "x-real-ip": "203.0.113.9",
              },
            },
          ),
          requestContext,
        ),
      );
      expect(forwarded.status).toBe(200);
      expect(yield* Effect.promise(() => forwarded.text())).toBe("child");
      expect(forwarded.headers.get("set-cookie")).toBeNull();
      expect(requests[0]?.url).toBe("http://child.test/api/auth/session");
      expect(requests[0]?.authorization).toBe("Bearer child-session");
      expect(requests[0]?.cookie).toBeUndefined();
      expect(requests[0]?.headers["x-hop-secret"]).toBeUndefined();
      expect(requests[0]?.headers["x-forwarded-for"]).toBeUndefined();
      expect(requests[0]?.headers["x-real-ip"]).toBeUndefined();
      const mcpForwarded = yield* Effect.promise(() =>
        web.handler(
          new Request("http://controller.test/api/cloud-sandboxes/managed/test/proxy/mcp", {
            method: "POST",
            headers: { authorization: "Bearer child-session", "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 0 }),
          }),
          requestContext,
        ),
      );
      expect(mcpForwarded.status).toBe(200);
      expect(requests.at(-1)?.url).toBe("http://child.test/mcp");
      for (const escapedUrl of [
        "http://controller.test/api/cloud-sandboxes/managed/test/proxy/private-file",
        "http://controller.test/api/cloud-sandboxes/managed/test/proxy/api/%2e%2e/private-file",
        "http://controller.test/api/cloud-sandboxes/managed/test/proxy/.well-known/%2e%2e/private-file",
        "http://controller.test/api/cloud-sandboxes/managed/test/proxy//evil.example/api",
      ]) {
        const escaped = yield* Effect.promise(() =>
          web.handler(new Request(escapedUrl), requestContext),
        );
        expect(escaped.status).toBe(404);
      }
      expect(f.connections()).toBe(1);
      expect(requests).toHaveLength(2);
    }).pipe(
      Effect.provide(
        authLayer.pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
      ),
    ),
);
