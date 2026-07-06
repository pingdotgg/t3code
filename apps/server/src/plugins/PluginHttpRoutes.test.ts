import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { pluginOperateScope } from "@t3tools/contracts";
import { PluginId } from "@t3tools/contracts/plugin";
import type { PluginHttpDescriptor } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { PluginHttpRegistry } from "./PluginHttpRegistry.ts";
import * as PluginHttpRegistryLayer from "./PluginHttpRegistry.ts";
import { pluginHttpRouteLayer } from "./PluginHttpRoutes.ts";

const pluginId = PluginId.make("http-plugin");

const canBindLoopback = async () => {
  const NodeNet = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.close(() => resolve(true));
    });
  });
};

const loopbackAvailable = await canBindLoopback();

const nodeHttpServerLayer = Layer.unwrap(
  Effect.promise(() => import("node:http")).pipe(
    Effect.map((NodeHttp) =>
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
      }),
    ),
  ),
);

const makeAuthLayer = (
  authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"],
) =>
  Layer.succeed(
    EnvironmentAuth.EnvironmentAuth,
    EnvironmentAuth.EnvironmentAuth.of({
      authenticateHttpRequest,
    } as EnvironmentAuth.EnvironmentAuth["Service"]),
  );

const authenticatedAuthLayer = makeAuthLayer(() =>
  Effect.succeed({
    sessionId: "session-1" as any,
    subject: "test",
    method: "bearer-access-token",
    scopes: [pluginOperateScope(pluginId)],
  }),
);

const unauthenticatedAuthLayer = makeAuthLayer(() =>
  Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError()),
);

const makeRouteLayer = (authLayer = authenticatedAuthLayer) =>
  HttpRouter.serve(pluginHttpRouteLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(PluginHttpRegistryLayer.layer),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(nodeHttpServerLayer),
    Layer.provideMerge(FetchHttpClient.layer),
  );

const routeUrl = (path: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    if (typeof address === "string" || !("port" in address)) {
      assert.fail(`Expected TCP address, got ${String(address)}`);
    }
    return `http://127.0.0.1:${address.port}${path}`;
  });

const postText = (path: string, body: string) =>
  Effect.gen(function* () {
    const url = yield* routeUrl(path);
    return yield* HttpClient.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(body, "text/plain")),
    );
  });

const getPath = (path: string) =>
  Effect.gen(function* () {
    const url = yield* routeUrl(path);
    return yield* HttpClient.get(url);
  });

it.layer(PluginHttpRegistryLayer.layer)("PluginHttpRegistry", (it) => {
  it.effect("matches method and path params for registered plugin routes", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHttpRegistry;
      yield* registry.put(pluginId, [
        {
          method: "POST",
          path: "/incoming/:name",
          auth: "public",
          handler: () => Effect.succeed({ status: 204 }),
        },
      ]);

      const matched = yield* registry.match({
        pluginId,
        method: "post",
        path: "/incoming/alice",
      });

      assert.isTrue(Option.isSome(matched));
      if (Option.isSome(matched)) {
        assert.deepEqual(matched.value.params, { name: "alice" });
      }
    }),
  );

  it.effect("does not match (rather than throwing) on a malformed percent-escape", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHttpRegistry;
      yield* registry.put(pluginId, [
        {
          method: "GET",
          path: "/item/:id",
          auth: "public",
          handler: () => Effect.succeed({ status: 204 }),
        },
      ]);

      // A bare "%" is an invalid escape; decodeURIComponent throws on it.
      // The matcher must degrade to no-match, so the route layer 404s rather
      // than turning a public request into a 500 defect.
      const matched = yield* registry.match({
        pluginId,
        method: "get",
        path: "/item/%E0%A4%A",
      });

      assert.isTrue(Option.isNone(matched));
    }),
  );

  it.effect("removes a plugin's routes so a closed-scope plugin stops matching", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHttpRegistry;
      yield* registry.put(pluginId, [
        {
          method: "GET",
          path: "/ping",
          auth: "public",
          handler: () => Effect.succeed({ status: 204 }),
        },
      ]);
      assert.isTrue(
        Option.isSome(yield* registry.match({ pluginId, method: "get", path: "/ping" })),
      );

      yield* registry.remove(pluginId);
      assert.isTrue(
        Option.isNone(yield* registry.match({ pluginId, method: "get", path: "/ping" })),
      );
    }),
  );
});

if (loopbackAvailable) {
  it.layer(makeRouteLayer())("plugin http route layer", (it) => {
    it.effect("round-trips a public route through the router", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/echo/:name",
            auth: "public",
            handler: (request) =>
              Effect.succeed({
                status: 201,
                headers: { "x-plugin-test": "ok" },
                body: {
                  name: request.params.name,
                  query: request.query.q,
                  body: new TextDecoder().decode(request.body),
                },
              }),
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/echo/chris?q=1", "hello");
        const body = yield* response.json;

        assert.equal(response.status, 201);
        assert.equal(response.headers["x-plugin-test"], "ok");
        assert.deepEqual(body, { name: "chris", query: "1", body: "hello" });
      }),
    );

    it.effect("returns 413 when the request body exceeds the route cap", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/limited",
            auth: "public",
            maxBodyBytes: 4,
            handler: () => Effect.succeed({ status: 204 }),
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/limited", "12345");

        assert.equal(response.status, 413);
      }),
    );

    it.effect("returns a generic 404 for unknown plugin routes", () =>
      Effect.gen(function* () {
        const response = yield* getPath("/hooks/plugins/missing-plugin/route");

        assert.equal(response.status, 404);
        assert.equal(yield* response.text, "Not Found");
      }),
    );

    it.effect("returns 500 for handler defects and continues serving later requests", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/boom",
            auth: "public",
            handler: () => Effect.die(new Error("boom")),
          },
          {
            method: "POST",
            path: "/ok",
            auth: "public",
            handler: () => Effect.succeed({ status: 200, body: "ok" }),
          },
        ]);

        const failed = yield* postText("/hooks/plugins/http-plugin/boom", "");
        assert.equal(failed.status, 500);
        assert.equal(yield* failed.text, "Internal Server Error");

        const ok = yield* postText("/hooks/plugins/http-plugin/ok", "");
        assert.equal(ok.status, 200);
        assert.equal(yield* ok.text, "ok");
      }),
    );
  });

  it.layer(makeRouteLayer(unauthenticatedAuthLayer))("plugin http token route layer", (it) => {
    it.effect("rejects unauthenticated token routes", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/token",
            auth: "token",
            handler: () => Effect.succeed({ status: 200 }),
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/token", "");

        assert.equal(response.status, 401);
      }),
    );
  });

  it.layer(makeRouteLayer())("plugin http authenticated route layer", (it) => {
    it.effect("allows token routes when the session has plugin operate scope", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/token",
            auth: "token",
            handler: () => Effect.succeed({ status: 200, body: "authorized" }),
          },
        ] satisfies ReadonlyArray<PluginHttpDescriptor>);

        const response = yield* postText("/hooks/plugins/http-plugin/token", "");

        assert.equal(response.status, 200);
        assert.equal(yield* response.text, "authorized");
      }),
    );
  });
} else {
  describe.skip("plugin http live route layer", () => {
    it("skips live router assertions when local TCP bind is unavailable", () => {});
  });
}
