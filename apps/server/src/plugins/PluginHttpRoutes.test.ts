import { assert, describe, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { pluginOperateScope } from "@t3tools/contracts";
import { PluginId } from "@t3tools/contracts/plugin";
import type { PluginHttpDescriptor, PluginHttpResponse } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import {
  makePluginHttpRouteLayer,
  pluginHttpRouteLayer,
  respondToPluginHandlerExit,
} from "./PluginHttpRoutes.ts";
import { makePluginLogger } from "./PluginLogger.ts";

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

const makeRouteLayer = (authLayer = authenticatedAuthLayer, routeLayer = pluginHttpRouteLayer) =>
  HttpRouter.serve(routeLayer, {
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
        // Spread to a plain object: params is a null-prototype map, so a direct
        // deepEqual against an object literal would compare prototypes.
        assert.deepEqual({ ...matched.value.params }, { name: "alice" });
      }
    }),
  );

  // A param literally named `__proto__` is a valid route parameter. On a plain
  // object the assignment `params["__proto__"] = value` routes through the
  // inherited setter and the decoded value is silently lost; the null-prototype
  // map must instead store it as an own property.
  it.effect("captures a param named __proto__ as an own property", () =>
    Effect.gen(function* () {
      const registry = yield* PluginHttpRegistry;
      yield* registry.put(pluginId, [
        {
          method: "GET",
          path: "/proto/:__proto__",
          auth: "public",
          handler: () => Effect.succeed({ status: 204 }),
        },
      ]);

      const matched = yield* registry.match({
        pluginId,
        method: "get",
        path: "/proto/injected",
      });

      assert.isTrue(Option.isSome(matched));
      if (Option.isSome(matched)) {
        const params = matched.value.params as Record<string, string>;
        assert.isTrue(Object.prototype.hasOwnProperty.call(params, "__proto__"));
        assert.equal(params["__proto__"], "injected");
        // The host prototype chain must be untouched.
        assert.equal(({} as Record<string, unknown>)["injected"], undefined);
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

describe("respondToPluginHandlerExit", () => {
  const logger = makePluginLogger(pluginId);
  const context = { method: "POST", path: "/hook" };

  it.effect("maps a successful handler exit to its HTTP response", () =>
    Effect.gen(function* () {
      const response = yield* respondToPluginHandlerExit(
        Exit.succeed({ status: 201, body: "ok" } satisfies PluginHttpResponse),
        logger,
        context,
      );
      assert.equal(response.status, 201);
    }),
  );

  it.effect("converts a genuine handler failure into a 500", () =>
    Effect.gen(function* () {
      const exit = (yield* Effect.exit(Effect.die(new Error("boom")))) as Exit.Exit<
        PluginHttpResponse,
        Error
      >;
      const response = yield* respondToPluginHandlerExit(exit, logger, context);
      assert.equal(response.status, 500);
    }),
  );

  it.effect("re-raises an interrupt instead of answering a 500 to a dead socket", () =>
    Effect.gen(function* () {
      const interruptedExit = (yield* Effect.exit(Effect.interrupt)) as Exit.Exit<
        PluginHttpResponse,
        Error
      >;
      const outcome = yield* Effect.exit(
        respondToPluginHandlerExit(interruptedExit, logger, context),
      );
      assert.isTrue(Exit.isFailure(outcome));
      if (Exit.isFailure(outcome)) {
        // Propagated as an interrupt — not swallowed into a 500 response value.
        assert.isTrue(Cause.hasInterruptsOnly(outcome.cause));
      }
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

    // A query key named `__proto__` is valid. On a plain object it would route
    // through the inherited accessor — mutating the prototype and dropping the
    // value — so the null-prototype query map must expose it as an own entry and
    // leave the prototype chain intact.
    it.effect("delivers a query key named __proto__ without polluting the prototype", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "GET",
            path: "/q",
            auth: "public",
            handler: (request) =>
              Effect.succeed({
                status: 200,
                body: {
                  own: Object.prototype.hasOwnProperty.call(request.query, "__proto__"),
                  value: (request.query as Record<string, unknown>)["__proto__"] ?? null,
                  polluted: ({} as Record<string, unknown>)["injected"] ?? null,
                },
              }),
          },
        ]);

        const response = yield* getPath("/hooks/plugins/http-plugin/q?__proto__=injected");
        const body = yield* response.json;

        assert.equal(response.status, 200);
        assert.deepEqual(body, { own: true, value: "injected", polluted: null });
      }),
    );

    it.effect("reaches a root '/' route with and without a trailing slash", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/",
            auth: "public",
            handler: () => Effect.succeed({ status: 200, body: "root" }),
          },
        ]);

        const withoutSlash = yield* postText("/hooks/plugins/http-plugin", "");
        assert.equal(withoutSlash.status, 200);
        assert.equal(yield* withoutSlash.text, "root");

        const withSlash = yield* postText("/hooks/plugins/http-plugin/", "");
        assert.equal(withSlash.status, 200);
        assert.equal(yield* withSlash.text, "root");
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

    // A plugin response shares the host origin: it must not be able to set
    // session/redirect/CORS headers that would hijack the host's browser
    // security context. Strip the denylisted headers, keep benign ones.
    it.effect("strips ambient-privilege response headers and keeps benign ones", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/headers",
            auth: "public",
            handler: () =>
              Effect.succeed({
                status: 200,
                headers: {
                  "Set-Cookie": "session=stolen",
                  Location: "https://evil.example",
                  "WWW-Authenticate": "Basic",
                  "access-control-allow-origin": "*",
                  "Clear-Site-Data": '"cookies", "storage"',
                  Refresh: "0; url=https://evil.example",
                  "content-type": "text/plain",
                  "x-foo": "bar",
                },
                body: "ok",
              }),
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/headers", "");

        assert.equal(response.status, 200);
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.headers["location"], undefined);
        assert.equal(response.headers["www-authenticate"], undefined);
        assert.equal(response.headers["access-control-allow-origin"], undefined);
        assert.equal(response.headers["clear-site-data"], undefined);
        assert.equal(response.headers["refresh"], undefined);
        assert.equal(response.headers["x-foo"], "bar");
        assert.isTrue((response.headers["content-type"] ?? "").includes("text/plain"));
      }),
    );

    it.effect("clamps an out-of-range plugin status to 500", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/bad-status",
            auth: "public",
            handler: () => Effect.succeed({ status: 999, body: "ok" }),
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/bad-status", "");

        assert.equal(response.status, 500);
      }),
    );
  });

  it.layer(
    makeRouteLayer(authenticatedAuthLayer, makePluginHttpRouteLayer({ handlerTimeoutMs: 100 })),
    {
      // Real clock: the handler deadline is a wall-clock sleep, so the default
      // TestClock (which never auto-advances) would hang the round-trip.
      excludeTestServices: true,
    },
  )("plugin http handler timeout", (it) => {
    // A hung handler (here `Effect.never`) must not pin the inbound request —
    // and its socket — open forever. The wall-clock deadline interrupts the
    // handler and answers 504 without routing through the 500 failure mapping.
    it.effect("answers 504 when the handler exceeds the wall-clock deadline", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/hang",
            auth: "public",
            handler: () => Effect.never,
          },
        ]);

        const response = yield* postText("/hooks/plugins/http-plugin/hang", "");

        assert.equal(response.status, 504);
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

    // Fail closed: descriptors are dynamically loaded JS, so any `auth` value
    // that is not the exact literal "public" must still require a token —
    // otherwise a typo/casing mistake ("Token"), an empty string, or a missing
    // field would silently expose the route.
    it.effect("requires auth when descriptor.auth is not the exact literal 'public'", () =>
      Effect.gen(function* () {
        const registry = yield* PluginHttpRegistry;
        yield* registry.put(pluginId, [
          {
            method: "POST",
            path: "/undefined-auth",
            auth: undefined,
            handler: () => Effect.succeed({ status: 200 }),
          },
          {
            method: "POST",
            path: "/miscased-auth",
            auth: "Token",
            handler: () => Effect.succeed({ status: 200 }),
          },
          {
            method: "POST",
            path: "/empty-auth",
            auth: "",
            handler: () => Effect.succeed({ status: 200 }),
          },
        ] as unknown as ReadonlyArray<PluginHttpDescriptor>);

        const undefinedAuth = yield* postText("/hooks/plugins/http-plugin/undefined-auth", "");
        const miscasedAuth = yield* postText("/hooks/plugins/http-plugin/miscased-auth", "");
        const emptyAuth = yield* postText("/hooks/plugins/http-plugin/empty-auth", "");

        assert.equal(undefinedAuth.status, 401);
        assert.equal(miscasedAuth.status, 401);
        assert.equal(emptyAuth.status, 401);
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
