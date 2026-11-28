import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import * as McpWebhookTransport from "./McpWebhookTransport.ts";

it.each([
  ["127.0.0.1", false],
  ["10.1.2.3", false],
  ["172.16.0.1", false],
  ["192.168.1.1", false],
  ["169.254.169.254", false],
  ["100.64.0.1", false],
  ["0.0.0.0", false],
  ["::1", false],
  ["fc00::1", false],
  ["fe80::1", false],
  ["::ffff:127.0.0.1", false],
  ["fec0::1", false],
  ["5f00::1", false],
  ["::ffff:0:102:304", false],
  ["8.8.8.8", true],
  ["2606:4700:4700::1111", true],
])("treats %s as globally routable: %s", (address, routable) => {
  expect(McpWebhookTransport.isGloballyRoutable(address)).toBe(routable);
});

it.effect("refuses private callbacks unless allowlisted, and the client never reaches them", () =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/redirect", HttpServerResponse.redirect("/target")),
        HttpRouter.add("POST", "/target", HttpServerResponse.text("reached")),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.build);
    const port = new URL(HttpServer.formatAddress((yield* HttpServer.HttpServer).address)).port;
    const guard = McpWebhookTransport.make(["127.0.0.1"]);
    const client = Context.get(yield* Layer.build(guard.layerClient), HttpClient.HttpClient);

    const refused = (url: string) =>
      guard.check(new URL(url)).pipe(
        Effect.flip,
        Effect.map((error) => error._tag),
      );
    expect(yield* refused("https://10.0.0.1/hook")).toBe("WebhookAddressRejected");
    expect(yield* refused("https://[::1]/hook")).toBe("WebhookAddressRejected");
    expect(yield* refused("https://localhost/hook")).toBe("WebhookAddressRejected");
    yield* guard.check(new URL(`http://127.0.0.1:${port}/hook`));
    expect(guard.allowsPlaintext(new URL("http://127.0.0.1/hook"))).toBe(true);
    expect(guard.allowsPlaintext(new URL("http://localhost/hook"))).toBe(false);

    // A redirect comes back as it is, never followed.
    const redirected = yield* client.post(`http://127.0.0.1:${port}/redirect`);
    expect(redirected.status).toBe(302);
    // The client resolves again when it connects, so a name for a private address fails there.
    const pinned = yield* Effect.flip(client.post(`http://localhost:${port}/target`));
    expect(pinned.reason._tag).toBe("TransportError");
    expect(String((pinned.reason as { readonly cause?: unknown }).cause)).toContain(
      "localhost is not a public address",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
