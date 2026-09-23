import { afterEach, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ExtensionHost } from "./ExtensionHost.ts";
import { vscodeIconRouteLayer, vscodeProxyRouteLayer } from "./ExtensionProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

it("forwards VS Code server paths through the wildcard route", async () => {
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ready")));
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    vscodeProxyRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            Effect.succeed({
              sessionId: AuthSessionId.make("test"),
              subject: "test",
              method: "bearer-access-token",
              scopes: [AuthOrchestrationOperateScope],
            }),
        } as unknown as EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ExtensionHost, {
          port: Effect.succeed(1234),
        } as unknown as ExtensionHost["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const response = await handler(
    new Request("http://t3.test/api/vscode/stable-commit/vscode-remote-resource?path=test"),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ready");
  expect(requests).toEqual([
    "http://127.0.0.1:1234/api/vscode/stable-commit/vscode-remote-resource?path=test",
  ]);
});

it("rejects read-only access to the proxy but allows extension icons", async () => {
  const auth = Layer.succeed(EnvironmentAuth, {
    authenticateWebSocketUpgrade: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: [AuthOrchestrationReadScope],
      }),
  } as unknown as EnvironmentAuth["Service"]);
  const host = Layer.succeed(ExtensionHost, {
    port: Effect.die("proxy must reject before starting the host"),
    iconPath: () => Effect.succeed(null),
  } as unknown as ExtensionHost["Service"]);
  const { handler, dispose } = HttpRouter.toWebHandler(
    vscodeProxyRouteLayer.pipe(
      Layer.provideMerge(auth),
      Layer.provideMerge(host),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("no request")),
        ),
      ),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const proxy = await handler(new Request("http://t3.test/api/vscode/test"));
  expect(proxy.status).toBe(403);

  const iconRoute = HttpRouter.toWebHandler(
    vscodeIconRouteLayer.pipe(
      Layer.provideMerge(auth),
      Layer.provideMerge(host),
      Layer.provideMerge(NodeHttpPlatform.layer),
    ),
    { disableLogger: true },
  );
  disposers.push(iconRoute.dispose);
  const icon = await iconRoute.handler(new Request("http://t3.test/api/vscode-icons/test.icon"));
  expect(icon.status).toBe(404);
});
