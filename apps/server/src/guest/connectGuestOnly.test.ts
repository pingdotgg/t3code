import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import * as ConnectGuestOnly from "./connectGuestOnly.ts";

const THROUGH_CONNECT = { "cf-connecting-ip": "203.0.113.7" };

it.effect("serves only the guest page and its routes to requests through T3 Connect", () =>
  Effect.gen(function* () {
    const { handler, dispose } = HttpRouter.toWebHandler(
      HttpRouter.add("*", "*", HttpServerResponse.text("served")).pipe(
        Layer.provide(ConnectGuestOnly.layer),
        Layer.provide(HttpServer.layerServices),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const status = (method: string, path: string, headers: Record<string, string>) =>
      Effect.promise(() =>
        handler(new Request(`http://env.t3.test${path}`, { method, headers })).then(
          (response) => response.status,
        ),
      );
    const cases: ReadonlyArray<readonly [string, string, number]> = [
      ["GET", "/guest", 200],
      ["GET", "/assets/index-abc123.js", 200],
      ["GET", "/favicon-32x32.png", 200],
      ["GET", "/manifest.webmanifest", 200],
      ["GET", "/api/guest/stream?share=abc", 200],
      ["POST", "/api/guest/messages?share=abc", 200],
      ["POST", "/api/t3-connect/health", 200],
      ["GET", "/", 404],
      ["GET", "/ws", 404],
      ["GET", "/pair", 404],
      ["GET", "/settings/access", 404],
      ["GET", "/.well-known/t3/environment", 404],
      ["POST", "/oauth/token", 404],
      ["POST", "/api/t3-connect/mint-credential", 404],
      ["POST", "/api/hooks/hook-1/token", 404],
      ["GET", "/api/assets/thread/file.png", 404],
      ["POST", "/guest", 404],
    ];
    for (const [method, path, expected] of cases) {
      assert.strictEqual(
        yield* status(method, path, THROUGH_CONNECT),
        expected,
        `${method} ${path}`,
      );
    }
    // Without the visitor IP header, Cloudflare's request id still marks the tunnel.
    assert.strictEqual(yield* status("GET", "/ws", { "cf-ray": "8f0c1d2e3f4a5b6c-FRA" }), 404);
    // Local, LAN and tailnet requests reach everything, as before.
    assert.strictEqual(yield* status("GET", "/ws", {}), 200);
  }).pipe(Effect.scoped),
);

it("refuses a raw path another route could resolve outside the guest routes", () => {
  for (const path of [
    "/preview/x/../../api/guest/stream",
    "/api/guest/%2e%2e/auth/session",
    "/api/guest/./x",
    "//api/guest/x",
    "/assets\\..\\index.html",
  ]) {
    assert.isFalse(ConnectGuestOnly.allowsConnectRequest("GET", path), path);
  }
});
